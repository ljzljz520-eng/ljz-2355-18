-- ============================================================================
-- 产品文档复审管理 · PostgreSQL Schema
--
-- 设计要点（对应需求）：
--   1. 页脚三要素：负责人(owner)、校验范围(coverage scope)、日期(签收日期)
--      —— 见 doc_review_claims / doc_review_item_results
--   2. 责任交接与审阅证据(PG 保存)：
--      doc_review_owner_history 记录每次转派；doc_review_claims 记录签收；
--      doc_review_item_results 记录逐项证据；history 只追加，不覆盖。
--   3. 负责人离职/小组调整 → 只转派"待办"（open/in_progress/overdue 任务），
--      已签收者(claim.signed_by)永不被覆盖。
--   4. 复审到期 → 只把页面状态切到 "信息需核实"(STALE)，不撤销历史可读内容，
--      也不改写历史签收记录；公开日期 = 最近一次"覆盖整个声明范围"的签收日期。
--   5. 检查了一处示例 ≠ 整篇已复审：
--      声明范围(coverage claim)必须被全部 item 结果覆盖，图必须满足声明范围。
--   6. 正文关键变化 → 受影响 item 回到 pending（待重验），已通过的不相关项保留。
--   7. 固定周期扫描 vs 依赖变更触发 → 两类后台任务，merge_key 合并 + 幂等台账。
--   8. 部分检查失败可签收：item 级别 pass/fail 并存，fail 原因公开可查
--      （维护者看到"为何超期"，而非只有黄色标签）。
-- ============================================================================

-- 扩展：用于 gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 枚举类型
-- ----------------------------------------------------------------------------
CREATE TYPE review_task_status AS ENUM (
  'open',         -- 待办
  'in_progress',  -- 处理中
  'signed',       -- 已签收（本轮完成）
  'stale',        -- 到期/正文变化：信息需核实（历史内容仍可读）
  'cancelled'     -- 已取消（发布版废弃等；历史签收仍保留）
);

CREATE TYPE review_item_result AS ENUM (
  'pending', -- 待重验 / 未检查
  'pass',
  'fail'
);

CREATE TYPE review_trigger_kind AS ENUM (
  'periodic_scan',  -- 固定周期扫描
  'dependency_change' -- 按依赖变更触发
);

-- ----------------------------------------------------------------------------
-- 文档与声明范围
-- ----------------------------------------------------------------------------

-- 文档页（doc_id 与站点路由对应，如 guide/installation）
CREATE TABLE IF NOT EXISTS docs (
  id              text PRIMARY KEY,                 -- 如 'guide/installation'
  latest_revision text NOT NULL DEFAULT '',         -- 当前正文修订标识（内容 hash）
  locale          text NOT NULL DEFAULT 'zh-CN',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 校验范围条目（声明范围）：文档"声明自己覆盖了什么"。
-- kind: example(示例) / section(章节) / diagram(覆盖图) / api / link ……
-- 一篇文档的完整声明范围 = 其全部 scope 条目；图必须满足声明范围。
CREATE TABLE IF NOT EXISTS doc_review_scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      text NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  ref         text NOT NULL,            -- 如 examples/button/basic.vue / 图节点 id
  label       text NOT NULL DEFAULT '',
  required    boolean NOT NULL DEFAULT true,
  -- 依赖指纹：该项依赖的上游（示例源码、API、图节点等）hash
  dep_fingerprint text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, kind, ref)
);

-- ----------------------------------------------------------------------------
-- 人员 / 小组（最小模型，真实环境可对接 IAM）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people (
  id        text PRIMARY KEY,           -- 如 'u_lihua'
  name      text NOT NULL,
  active    boolean NOT NULL DEFAULT true,  -- false = 离职
  team_id   text
);

CREATE TABLE IF NOT EXISTS teams (
  id        text PRIMARY KEY,
  name      text NOT NULL
);

-- ----------------------------------------------------------------------------
-- 复审任务（后台按发布版生成）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_review_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id         text NOT NULL REFERENCES docs(id),
  release_id     text NOT NULL,          -- 发布版，如 'v2.4.0'
  status         review_task_status NOT NULL DEFAULT 'open',
  owner_id       text REFERENCES people(id),  -- 当前待办负责人；可空 = 无继任负责人
  due_at         timestamptz,             -- 到期时刻（timestamptz，支持站点时区切换）
  created_by     text NOT NULL DEFAULT 'system',
  created_via    review_trigger_kind NOT NULL, -- 该任务最初的产生方式
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- 任务合并：同一(doc, release)的"活跃轮"只有一条任务。
  -- periodic_scan 与 dependency_change 命中同一 merge_key 时合并为一行；
  -- 上一轮 signed/cancelled 后允许用同一 merge_key 开新一轮（历史轮永久保留），
  -- 因此唯一约束是"仅活跃状态部分唯一"，见下方部分索引。
  merge_key      text NOT NULL,
  round_no       integer NOT NULL DEFAULT 1
);

-- 活跃任务部分唯一索引：两类触发合并 + 重复触发幂等的数据库层保障。
CREATE UNIQUE INDEX IF NOT EXISTS uq_review_task_active_merge
  ON doc_review_tasks(merge_key)
  WHERE status IN ('open', 'in_progress', 'stale');

CREATE INDEX IF NOT EXISTS idx_review_tasks_owner ON doc_review_tasks(owner_id)
  WHERE status IN ('open', 'in_progress', 'stale');
CREATE INDEX IF NOT EXISTS idx_review_tasks_due ON doc_review_tasks(due_at)
  WHERE status IN ('open', 'in_progress', 'stale');

-- 触发幂等台账：周期扫描批次 与 依赖变更事件 都在此登记。
-- 重跑提醒任务时，用相同 idempotency_key upsert，命中即跳过，不重复提醒。
CREATE TABLE IF NOT EXISTS review_trigger_ledger (
  idempotency_key text PRIMARY KEY,       -- 如 scan:2026-10-05 / dep:<event-uuid>
  kind            review_trigger_kind NOT NULL,
  ref             text NOT NULL,          -- release 或 依赖事件 id
  task_id         uuid REFERENCES doc_review_tasks(id),
  payload_hash    text NOT NULL DEFAULT '',-- 同一事件但指纹变化时可识别
  ran_at          timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 责任交接（只追加，不可变）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_review_owner_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES doc_review_tasks(id),
  doc_id      text NOT NULL,
  release_id  text NOT NULL,
  from_owner  text,                       -- 可空（首次分派）
  to_owner    text,                       -- 可空（无继任负责人，悬空待办）
  reason      text NOT NULL DEFAULT '',   -- leave(离职)/team_adjust(小组调整)/manual
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);
-- 无 UPDATE/DELETE 权限应由应用层 + 仅追加规则约束：
CREATE OR REPLACE FUNCTION review_owner_history_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'owner history is append-only; 责任交接记录不可变';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_owner_history_no_update ON doc_review_owner_history;
CREATE TRIGGER trg_owner_history_no_update
  BEFORE UPDATE OR DELETE ON doc_review_owner_history
  FOR EACH ROW EXECUTE FUNCTION review_owner_history_immutable();

-- ----------------------------------------------------------------------------
-- 签收（页脚日期来源）与逐项审阅证据
-- ----------------------------------------------------------------------------

-- 一轮签收。sign 时记录签收人；后续转派只改任务 owner，不改 signed_by。
CREATE TABLE IF NOT EXISTS doc_review_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid NOT NULL REFERENCES doc_review_tasks(id),
  doc_id         text NOT NULL,
  release_id     text NOT NULL,
  signed_by      text NOT NULL,                 -- 曾签收者，永不被覆盖
  signed_by_name text NOT NULL DEFAULT '',
  signed_at      timestamptz NOT NULL DEFAULT now(),
  -- 签收时页面正文修订：签收时页面更新，证据锚定当时版本
  doc_revision   text NOT NULL,
  -- 声明范围指纹：签收覆盖的 scope 集合 hash。
  claimed_scope_fingerprint text NOT NULL,
  -- 是否真实完整覆盖声明范围：所有 required item 均为 pass。
  -- 部分失败/部分未检仍允许签收(full_scope=false)，但不能作为"整篇已复审"的公开日期；
  -- 公开日期只取 full_scope=true 的最近签收。
  full_scope     boolean NOT NULL DEFAULT false,
  note           text NOT NULL DEFAULT '',
  -- 同一任务允许留档多次"部分失败签收"，最终一次 full_scope 签收关闭本轮；
  -- 因此不在 task_id 上加唯一约束（重复提交由应用层 + 触发台账保证幂等）。
  created_seq     integer NOT NULL GENERATED ALWAYS AS IDENTITY
);

-- 逐项审阅证据（检查了一处示例 ≠ 整篇：每个 scope 一行证据）
CREATE TABLE IF NOT EXISTS doc_review_item_results (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id    uuid NOT NULL REFERENCES doc_review_claims(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES doc_review_tasks(id),
  scope_id    uuid NOT NULL REFERENCES doc_review_scopes(id),
  result      review_item_result NOT NULL DEFAULT 'pending',
  checker     text NOT NULL DEFAULT '',
  checked_at  timestamptz,
  evidence    text NOT NULL DEFAULT '',   -- 证据（截图 id / 链接 / 说明）
  fail_reason text NOT NULL DEFAULT '',   -- 失败原因：公开"为何超期/未过"
  -- 签收时该项依赖指纹；正文/依赖变化后与之比对，决定是否回到 pending
  checked_fingerprint text NOT NULL DEFAULT '',
  UNIQUE (claim_id, scope_id)
);

-- ----------------------------------------------------------------------------
-- 正文 / 依赖关键变化 → 相关项回到待重验
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doc_content_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        text NOT NULL REFERENCES docs(id),
  revision      text NOT NULL,            -- 新正文 hash
  changed_at    timestamptz NOT NULL DEFAULT now(),
  change_kind   text NOT NULL DEFAULT 'body', -- body(正文关键变化)/dependency
  affected_scopes uuid[] NOT NULL DEFAULT '{}', -- 受影响 scope；空数组=全部重验
  summary       text NOT NULL DEFAULT ''
);

-- ----------------------------------------------------------------------------
-- 公开视图：页脚三要素 + 状态 + 超期原因
--   - 公开日期(public_date) 只取 full_scope = true 的最近签收；
--   - stale（信息需核实）不删除/不改写任何历史签收，历史内容仍可读；
--   - overdue_reason 给维护者"为什么超期"，而不只是一个黄色标签。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_doc_public_review AS
WITH latest_full_claim AS (
  SELECT DISTINCT ON (c.doc_id)
         c.doc_id,
         c.signed_by, c.signed_by_name, c.signed_at,
         c.claimed_scope_fingerprint
  FROM doc_review_claims c
  WHERE c.full_scope = true
  ORDER BY c.doc_id, c.signed_at DESC
),
open_todo AS (
  SELECT t.doc_id,
         string_agg(DISTINCT p.name, '、') FILTER (WHERE p.id IS NOT NULL) AS todo_owners,
         min(t.due_at) AS nearest_due
  FROM doc_review_tasks t
  LEFT JOIN people p ON p.id = t.owner_id
  WHERE t.status IN ('open','in_progress','stale')
  GROUP BY t.doc_id
)
SELECT
  d.id AS doc_id,
  d.locale,
  f.signed_by_name AS owner_name,          -- 页脚：负责人（最近完整签收人）
  f.claimed_scope_fingerprint AS scope_ref,-- 页脚：校验范围（指纹，前端解析明细）
  f.signed_at AS public_signed_at,         -- 页脚：公开日期=真实完成范围的日期
  o.todo_owners,                           -- 当前待办负责人（可能为空=无继任）
  CASE
    WHEN f.signed_at IS NULL THEN 'never_reviewed'
    WHEN EXISTS (SELECT 1 FROM doc_content_changes cc
                  WHERE cc.doc_id = d.id AND cc.changed_at > f.signed_at)
      OR EXISTS (SELECT 1 FROM doc_review_tasks t
                  WHERE t.doc_id = d.id AND t.status = 'stale')
      THEN 'needs_verification'   -- 只提示信息需核实，历史内容/日期仍可读
    ELSE 'current'
  END AS page_state,
  o.nearest_due
FROM docs d
LEFT JOIN latest_full_claim f ON f.doc_id = d.id
LEFT JOIN open_todo o ON o.doc_id = d.id;

-- 维护者视图：超期/未过的可读原因（失败项 + 未覆盖项 + 触发来源）
CREATE OR REPLACE VIEW v_doc_overdue_reasons AS
SELECT t.doc_id, t.release_id, t.id AS task_id, t.status, t.due_at,
       p.name AS owner_name,
       (SELECT count(*) FROM doc_review_scopes s WHERE s.doc_id = t.doc_id AND s.required)
         AS required_total,
       (SELECT count(*) FROM doc_review_item_results r
          JOIN doc_review_claims c ON c.id = r.claim_id
          JOIN doc_review_scopes s ON s.id = r.scope_id
        WHERE c.task_id = t.id AND s.required AND r.result = 'pass')
         AS passed,
       (SELECT string_agg(s.label || COALESCE(NULLIF('：'||r.fail_reason,'：'),''), '；')
          FROM doc_review_scopes s
          LEFT JOIN doc_review_item_results r
            ON r.scope_id = s.id
           AND r.claim_id = (SELECT max(id) FROM doc_review_claims WHERE task_id = t.id)
          WHERE s.doc_id = t.doc_id AND s.required
            AND (r.result IS DISTINCT FROM 'pass'))
         AS unresolved_summary
FROM doc_review_tasks t
LEFT JOIN people p ON p.id = t.owner_id
WHERE t.status IN ('open','in_progress','stale');
