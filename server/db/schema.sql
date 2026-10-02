-- ============================================================================
-- 产品文档复审管理 - PostgreSQL Schema
-- 约定：
--   * 所有时刻一律 timestamptz 存储；tz 仅用于"周期桶/按天展示"的时区换算。
--   * 历史内容永不因复审到期而下架；公开端只读取 status / 最近签收事实。
--   * 签收、证据、交接均为只追加(append-only)，由触发器阻止 UPDATE/DELETE。
--   * 幂等由三处 UNIQUE 约束保证：release/page、(task_id,idem_key)、item/hash。
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 文档页面
-- ---------------------------------------------------------------------------
CREATE TABLE doc_page (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path            text NOT NULL UNIQUE,          -- 规范化路由，如 /components/button
  lang            text NOT NULL DEFAULT 'zh-CN',
  title           text NOT NULL,
  current_hash    text,                          -- 正文当前内容哈希（git blob sha 等）
  published_at    timestamptz,                   -- 最近一次随发布版发布的时间
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 页面的"声明校验范围"：页面在页脚公开承诺审阅覆盖什么
-- 例如 ['examples/**', 'api/**'] 表示示例与 API 段都应被审阅项覆盖
CREATE TABLE page_declared_scope (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id   uuid NOT NULL REFERENCES doc_page(id) ON DELETE CASCADE,
  pattern   text NOT NULL,                      -- 图(coverage graph)节点 glob
  UNIQUE (page_id, pattern)
);

-- ---------------------------------------------------------------------------
-- 责任人与责任交接（append-only）
-- ---------------------------------------------------------------------------
CREATE TABLE team_member (
  id          text PRIMARY KEY,                 -- 工号/账号
  display_name text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  left_at     timestamptz                       -- 离职时间
);

-- owner 永远以"最新一条有效交接"为准；历史签收者来自 review_signoff，不被覆盖
CREATE TABLE owner_handover (
  id           bigserial PRIMARY KEY,
  page_id      uuid NOT NULL REFERENCES doc_page(id) ON DELETE CASCADE,
  from_owner   text REFERENCES team_member(id),
  to_owner     text REFERENCES team_member(id), -- 可空：无继任负责人
  reason       text NOT NULL CHECK (reason IN ('leave', 'team_adjust', 'manual')),
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_handover_page ON owner_handover(page_id, effective_at DESC);

-- ---------------------------------------------------------------------------
-- 发布版：后台按发布版为每个页面生成维护任务
-- ---------------------------------------------------------------------------
CREATE TABLE doc_release (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version      text NOT NULL,                   -- 语义版本/构建号
  released_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version)
);

-- 幂等键 #1：同一发布版 + 同一页面最多生成一条发布任务记录
CREATE TABLE release_page (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id   uuid NOT NULL REFERENCES doc_release(id) ON DELETE CASCADE,
  page_id      uuid NOT NULL REFERENCES doc_page(id),
  content_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, page_id)
);

-- ---------------------------------------------------------------------------
-- 审阅项（覆盖"图"上的节点）与版本
-- ---------------------------------------------------------------------------
CREATE TABLE review_item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id     uuid NOT NULL REFERENCES doc_page(id) ON DELETE CASCADE,
  node        text NOT NULL,                    -- 图节点 glob，如 examples/button/basic.vue
  title       text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, node)
);

-- 正文关键变化会产生新版本：该节点上的旧结论作废 → 相关项需要重验
CREATE TABLE review_item_revision (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES review_item(id) ON DELETE CASCADE,
  content_hash    text NOT NULL,                -- 该节点对应内容快照哈希
  revision_no     int NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, content_hash)
);

-- 检查记录（append-only）：一条 = 对某审阅项某版本的一次检查
CREATE TABLE review_check (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES review_item(id),
  revision_id   uuid NOT NULL REFERENCES review_item_revision(id),
  result        text NOT NULL CHECK (result IN ('pass', 'fail')),
  note          text,
  checked_by    text NOT NULL REFERENCES team_member(id),
  checked_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_check_item_rev ON review_check(item_id, revision_id, checked_at DESC);

-- ---------------------------------------------------------------------------
-- 维护任务：周期扫描 与 依赖变更触发 在此合并
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance_task (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id        uuid NOT NULL REFERENCES doc_page(id),
  task_type      text NOT NULL CHECK (task_type IN ('release', 'periodic', 'dependency', 'merged')),
  trigger_source text NOT NULL,
  -- periodic: 'cycle:<period>:<bucket>'  bucket 按页面 tz 折算的周期起始时刻
  -- dependency: 'dep:<depId>:<depVersion>'
  idem_key       text NOT NULL,
  period_days    int,
  due_at         timestamptz NOT NULL,
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'blocked_no_owner', 'done', 'superseded')),
  current_owner  text REFERENCES team_member(id),   -- 转派改这里；签收者不受影响
  merged_into    uuid REFERENCES maintenance_task(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  UNIQUE (page_id, idem_key)                     -- 幂等键 #2：重复触发不产生新任务
);
CREATE INDEX idx_task_open ON maintenance_task(page_id, status, due_at);
CREATE INDEX idx_task_cycle ON maintenance_task(page_id, task_type, due_at);

-- 任务 ↔ 审阅项（一条任务可覆盖多个项；合并时汇总）
CREATE TABLE task_item (
  task_id  uuid NOT NULL REFERENCES maintenance_task(id) ON DELETE CASCADE,
  item_id  uuid NOT NULL REFERENCES review_item(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, item_id)
);

-- 任务转派流水（append-only），回答"为何超期/任务在谁手上转过手"
CREATE TABLE task_assignment_log (
  id           bigserial PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES maintenance_task(id) ON DELETE CASCADE,
  from_owner   text,
  to_owner     text,                            -- NULL = 无继任，进入 blocked_no_owner
  reason       text NOT NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now()
);

-- 提醒：每个任务每条提醒只发一次（提醒任务可安全重跑）
CREATE TABLE task_reminder (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES maintenance_task(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('due_soon', 'overdue')),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, kind)                        -- 幂等键 #3
);

-- ---------------------------------------------------------------------------
-- 签收与证据（append-only，PG 永久保存责任交接与审阅证据）
-- ---------------------------------------------------------------------------
-- outcome=partial 时只记录当次实际通过的 item 范围 → 公开日期反映真实完成范围
CREATE TABLE review_signoff (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid REFERENCES maintenance_task(id),
  page_id         uuid NOT NULL REFERENCES doc_page(id),
  signer          text NOT NULL REFERENCES team_member(id),  -- 曾签收者，永不被转派覆盖
  outcome         text NOT NULL CHECK (outcome IN ('full', 'partial')),
  scope_snapshot  jsonb NOT NULL,               -- 签收时实际覆盖的 node 列表（证据快照）
  page_hash       text NOT NULL,                -- 签收时正文哈希；正文变化后旧签收只代表历史
  comment         text,
  signed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_signoff_page ON review_signoff(page_id, signed_at DESC);

CREATE TABLE signoff_item (
  signoff_id   uuid NOT NULL REFERENCES review_signoff(id) ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES review_item(id),
  revision_id  uuid NOT NULL REFERENCES review_item_revision(id),
  PRIMARY KEY (signoff_id, item_id)
);

CREATE TABLE review_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signoff_id  uuid REFERENCES review_signoff(id) ON DELETE CASCADE,
  check_id    uuid REFERENCES review_check(id),
  kind        text NOT NULL CHECK (kind IN ('screenshot', 'log', 'note', 'link')),
  uri         text NOT NULL,
  hash        text,
  uploaded_by text NOT NULL REFERENCES team_member(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 防篡改：责任与证据类表只追加
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_review_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only; % is forbidden',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_signoff_immutable
  BEFORE UPDATE OR DELETE ON review_signoff
  FOR EACH ROW EXECUTE FUNCTION fn_review_immutable();
CREATE TRIGGER trg_check_immutable
  BEFORE UPDATE OR DELETE ON review_check
  FOR EACH ROW EXECUTE FUNCTION fn_review_immutable();
CREATE TRIGGER trg_evidence_immutable
  BEFORE UPDATE OR DELETE ON review_evidence
  FOR EACH ROW EXECUTE FUNCTION fn_review_immutable();
CREATE TRIGGER trg_handover_immutable
  BEFORE UPDATE OR DELETE ON owner_handover
  FOR EACH ROW EXECUTE FUNCTION fn_review_immutable();

-- ---------------------------------------------------------------------------
-- 当前负责人视图：取最新一条有效交接；to_owner 为空表示暂无继任
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_page_current_owner AS
SELECT DISTINCT ON (p.id)
  p.id AS page_id, p.path,
  h.to_owner AS owner_id,
  h.reason AS last_change_reason,
  h.effective_at AS owner_since
FROM doc_page p
LEFT JOIN owner_handover h ON h.page_id = p.id
ORDER BY p.id, h.effective_at DESC, h.id DESC;
