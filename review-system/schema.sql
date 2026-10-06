-- =====================================================================
-- 产品文档复审管理 · PostgreSQL DDL
-- 所有时间戳使用 timestamptz（UTC 存储），周期/到期按站点时区换算（见 src/time.js）。
-- =====================================================================

-- 人员 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_users (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  grp         text,                       -- 小组（group 为保留字，列名用 grp）
  active      boolean NOT NULL DEFAULT true,
  left_at     timestamptz,                -- 离职时间（历史用户保留，不物理删除）
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 文档 ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_docs (
  id                 text PRIMARY KEY,
  path               text NOT NULL,
  title              text NOT NULL,
  owner_id           text REFERENCES review_users(id),
  grp                text,
  current_release_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (path)
);

-- 发布版：复审以"发布版"为单位 --------------------------------------
CREATE TABLE IF NOT EXISTS review_releases (
  id                text PRIMARY KEY,
  doc_id            text NOT NULL REFERENCES review_docs(id),
  version           text NOT NULL,
  published_at      timestamptz NOT NULL DEFAULT now(),
  content_hash      text NOT NULL,                  -- 正文内容指纹
  blocks            jsonb NOT NULL DEFAULT '[]',   -- 分块 hash + dependsOn
  declared_scope    jsonb NOT NULL DEFAULT '[]',   -- 声明的复审范围
  interval_days     integer NOT NULL DEFAULT 30,   -- 固定复审周期
  -- 公开日期：仅在完整范围签收通过时写入；失效后可置 NULL 并再次前移，
  -- last_public_date_meta 记录上一次真实完成范围，历史内容从不撤回。
  public_date       timestamptz,
  last_public_date  timestamptz,
  last_verified_at  timestamptz,   -- 最近一次完整范围签收（周期锚点，不随失效清空）
  supersedes        text,
  UNIQUE (doc_id, version)
);
CREATE INDEX IF NOT EXISTS idx_releases_doc ON review_releases(doc_id);

-- 审阅项（覆盖图：covers 的并集必须覆盖 declared_scope） --------------
CREATE TABLE IF NOT EXISTS review_check_items (
  id           text PRIMARY KEY,
  release_id   text NOT NULL REFERENCES review_releases(id),
  target_id    text NOT NULL,
  label        text NOT NULL,
  kind         text NOT NULL DEFAULT 'target',
  covers       jsonb NOT NULL DEFAULT '[]',  -- 该项实际核对的目标
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','passed','failed','na')),
  -- 待重验：正文关键变化 / 依赖变更使旧结论失效
  revalidate   jsonb,
  evidence     jsonb NOT NULL DEFAULT '[]',
  checked_by_id text REFERENCES review_users(id),
  checked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_checks_release ON review_check_items(release_id);

-- 维护任务（周期与依赖触发合并为同一打开任务） ------------------------
CREATE TABLE IF NOT EXISTS review_tasks (
  id           text PRIMARY KEY,
  release_id   text NOT NULL REFERENCES review_releases(id),
  doc_id       text NOT NULL REFERENCES review_docs(id),
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','in_progress','unassigned','done','superseded','cancelled')),
  assignee_id  text REFERENCES review_users(id),  -- 离职/调整后改派；NULL=无继任
  created_at   timestamptz NOT NULL DEFAULT now(),
  due_date     timestamptz NOT NULL,
  closed_at    timestamptz,
  closed_reason text,
  cycle_index  integer NOT NULL DEFAULT 1,
  -- triggers: [{kind:'schedule'|'dependency'|'transfer', at, ...明细}]
  -- 合并策略：同 release 只保留一个打开任务，触发记录追加；
  -- 幂等策略：schedule 按 cycle_index，dependency 按 (reason,targets,站点日)。
  triggers     jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_tasks_release_open ON review_tasks(release_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON review_tasks(assignee_id);

-- 签收证据（只追加、不可变；转派不改写 signed_by） --------------------
CREATE TABLE IF NOT EXISTS review_signoffs (
  id                 text PRIMARY KEY,
  release_id         text NOT NULL REFERENCES review_releases(id),
  doc_id             text NOT NULL REFERENCES review_docs(id),
  signed_by_id       text REFERENCES review_users(id),
  signed_at          timestamptz NOT NULL DEFAULT now(),
  scope              jsonb NOT NULL DEFAULT '[]',      -- 签收覆盖的目标集
  checks_passed      jsonb NOT NULL DEFAULT '[]',
  scope_fingerprint  text NOT NULL,                     -- 防重复签收
  published_date     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_signoff_fp ON review_signoffs(release_id, scope_fingerprint);

-- 责任交接链 ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_handovers (
  id                text PRIMARY KEY,
  at                timestamptz NOT NULL DEFAULT now(),
  kind              text NOT NULL CHECK (kind IN ('user','group')),
  subject_id        text NOT NULL,          -- 离职用户 或 被调整小组
  to_user_id        text REFERENCES review_users(id),  -- 可空：无继任
  reason            text,
  affected_doc_ids  jsonb NOT NULL DEFAULT '[]',
  affected_task_ids jsonb NOT NULL DEFAULT '[]'
);

-- 提醒（任务+站点日历日+渠道 唯一：重跑幂等） -------------------------
CREATE TABLE IF NOT EXISTS review_reminders (
  id              text PRIMARY KEY,
  task_id         text NOT NULL REFERENCES review_tasks(id),
  day             date NOT NULL,            -- 站点时区下的日历日
  channel         text NOT NULL DEFAULT 'default',
  at              timestamptz NOT NULL DEFAULT now(),
  to_user         text,
  unassigned      boolean NOT NULL DEFAULT false,
  overdue_reasons jsonb NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reminder_day ON review_reminders(task_id, day, channel);

-- 通用审阅证据（检查截图、签收快照、交接备注等） ----------------------
CREATE TABLE IF NOT EXISTS review_evidence (
  id        text PRIMARY KEY,
  kind      text NOT NULL CHECK (kind IN ('check','signoff','handover','note')),
  ref_id    text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  by_user   text REFERENCES review_users(id),
  status    text,
  payload   jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_evidence_ref ON review_evidence(ref_id);

-- 历史可读内容永不撤回：本 schema 不提供任何 delete/unpublish 路径；
-- 新版发布只把旧任务置为 superseded，旧 release / signoff / evidence 全部保留。
