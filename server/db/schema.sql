-- 产品文档复审管理 - PostgreSQL schema
--
-- 设计要点：
--   * signoffs / handovers / evidence / audit_logs 全部 append-only；
--     另有触发器在数据库层面禁止 UPDATE/DELETE 签收记录（责任不被覆盖）。
--   * 任务幂等靠 idempotency 表的 UNIQUE 键：
--       fixed:<release>:<doc>、change:<release>:<doc>:<kind>:<path>:<hash>、
--       reminder:<task>:<windowStart>:<windowEnd>
--   * 所有绝对时间存 timestamptz；按站点时区的日历日运算在应用层完成。

BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id    TEXT NOT NULL REFERENCES groups(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (group_id, user_id)
);

-- 文档当前责任归属。历史责任以 handovers 为准，owner_id 只表示“当前待办负责人”。
CREATE TABLE IF NOT EXISTS docs (
  id              TEXT PRIMARY KEY,
  route           TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  owner_id        TEXT REFERENCES users(id),
  group_id        TEXT REFERENCES groups(id),
  cycle_days      INTEGER NOT NULL DEFAULT 90,
  declared_scope  TEXT[] NOT NULL DEFAULT ARRAY['body','examples','figures'],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS releases (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  published_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS triggers (
  id           TEXT PRIMARY KEY,
  release_id   TEXT NOT NULL REFERENCES releases(id),
  doc_id       TEXT NOT NULL REFERENCES docs(id),
  type         TEXT NOT NULL CHECK (type IN ('fixed','change')),
  reason       TEXT NOT NULL,
  caused_by    JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_triggers_doc ON triggers(doc_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  doc_id             TEXT NOT NULL REFERENCES docs(id),
  release_id         TEXT NOT NULL REFERENCES releases(id),
  status             TEXT NOT NULL CHECK (status IN ('open','signed','superseded')),
  due_date           TIMESTAMPTZ NOT NULL,
  trigger_ids        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reasons            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reminder_count     INTEGER NOT NULL DEFAULT 0,
  latest_reminder_at TIMESTAMPTZ,
  signed_scope_count INTEGER,
  completed_at       TIMESTAMPTZ,
  superseded_by      TEXT REFERENCES tasks(id),
  superseded_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 同一发布版 + 文档至多一个 open 任务（由应用 upsert + 该唯一索引共同保证）
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_task
  ON tasks(doc_id, release_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_tasks_doc ON tasks(doc_id);

CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  item_key      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('body','example','figure','table','config')),
  path          TEXT NOT NULL,
  content_hash  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending','passed','failed')),
  checked_at    TIMESTAMPTZ,
  checked_by    TEXT,
  UNIQUE (task_id, item_key)
);

CREATE TABLE IF NOT EXISTS checks (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  item_key             TEXT NOT NULL,
  result               TEXT NOT NULL CHECK (result IN ('passed','failed')),
  by_user              TEXT NOT NULL,
  note                 TEXT,
  content_hash_at_check TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checks_task ON checks(task_id);

-- 签收：append-only。scope 快照记录“真实完成范围”（公开日期以此为准）。
CREATE TABLE IF NOT EXISTS signoffs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  doc_id       TEXT NOT NULL REFERENCES docs(id),
  release_id   TEXT NOT NULL REFERENCES releases(id),
  by_user      TEXT NOT NULL,          -- 签收者永久留痕，不随转派/离职改变
  note         TEXT,
  scope        JSONB NOT NULL,         -- [{itemKey,kind,path,hash}]
  scope_kinds  TEXT[] NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signoffs_doc ON signoffs(doc_id, created_at);

-- 责任交接：每次离职/小组调整一条记录（含当时挂起的任务列表）。
CREATE TABLE IF NOT EXISTS handovers (
  id              TEXT PRIMARY KEY,
  doc_id          TEXT NOT NULL REFERENCES docs(id),
  from_owner_id   TEXT,
  to_owner_id     TEXT,                -- 允许 NULL：暂无继任负责人
  open_task_ids   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  reason          TEXT,
  by_user         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_handovers_doc ON handovers(doc_id, created_at);

-- 审阅证据：截图/笔记/链接等，关联到检查或签收。
CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  check_id    TEXT REFERENCES checks(id),
  signoff_id  TEXT REFERENCES signoffs(id),
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  kind        TEXT NOT NULL CHECK (kind IN ('screenshot','note','link','file')),
  ref         TEXT NOT NULL,
  sha256      TEXT,
  by_user     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);

-- 内容版本（正文/示例/图的每次关键变更）
CREATE TABLE IF NOT EXISTS content_versions (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL REFERENCES docs(id),
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  release_id  TEXT REFERENCES releases(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_versions_lookup ON content_versions(doc_id, kind, path, created_at);

-- 提醒：同一任务同一站点本地日窗口唯一，重跑只累加 run_count。
CREATE TABLE IF NOT EXISTS reminders (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  overdue       BOOLEAN NOT NULL,
  days_left     INTEGER NOT NULL,
  reasons       JSONB NOT NULL,
  run_count     INTEGER NOT NULL DEFAULT 1,
  last_rerun_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, window_start, window_end)
);

-- 通用幂等键（fixed / change 触发）
CREATE TABLE IF NOT EXISTS idempotency (
  key          TEXT PRIMARY KEY,
  ref_id       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 数据库层面禁止修改/删除签收与交接记录（责任与审阅证据不可覆盖）
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_signoffs_immutable ON signoffs;
CREATE TRIGGER trg_signoffs_immutable
  BEFORE UPDATE OR DELETE ON signoffs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS trg_handovers_immutable ON handovers;
CREATE TRIGGER trg_handovers_immutable
  BEFORE UPDATE OR DELETE ON handovers
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

DROP TRIGGER IF EXISTS trg_evidence_immutable ON evidence;
CREATE TRIGGER trg_evidence_immutable
  BEFORE UPDATE OR DELETE ON evidence
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

COMMIT;
