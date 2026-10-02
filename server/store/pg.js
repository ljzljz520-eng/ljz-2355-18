// PostgreSQL 仓储：与 store/memory.js 同构，供真实后台使用。
//
// 用法：
//   const repo = new PgRepo({ connectionString: process.env.DATABASE_URL })
//   await repo.init()                       // 自动执行 db/schema.sql
//   await engine.scanFixed('2026.10', ...)
//
// 所有方法使用参数化查询；签收/交接/证据由数据库触发器保证 append-only。
// pg 为可选依赖（npm i pg）；未安装时只在实例化/使用时报错。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 表 -> 行映射（snake_case <-> camelCase）
const TABLES = {
  users: { table: 'users', columns: { id: 'id', name: 'name', active: 'active', createdAt: 'created_at' } },
  groups: { table: '"groups"', columns: { id: 'id', name: 'name' } },
  groupMembers: { table: 'group_members',
    columns: { id: null, groupId: 'group_id', userId: 'user_id' } },
  docs: { table: 'docs', columns: {
    id: 'id', route: 'route', title: 'title', ownerId: 'owner_id', groupId: 'group_id',
    cycleDays: 'cycle_days', declaredScope: 'declared_scope', createdAt: 'created_at'
  } },
  releases: { table: 'releases', columns: { id: 'id', name: 'name', publishedAt: 'published_at' } },
  triggers: { table: 'triggers', columns: {
    id: 'id', releaseId: 'release_id', docId: 'doc_id', type: 'type',
    reason: 'reason', causedBy: 'caused_by', createdAt: 'created_at'
  } },
  tasks: { table: 'tasks', columns: {
    id: 'id', docId: 'doc_id', releaseId: 'release_id', status: 'status',
    dueDate: 'due_date', triggerIds: 'trigger_ids', reasons: 'reasons',
    reminderCount: 'reminder_count', latestReminderAt: 'latest_reminder_at',
    signedScopeCount: 'signed_scope_count', completedAt: 'completed_at',
    supersededBy: 'superseded_by', supersededAt: 'superseded_at', createdAt: 'created_at'
  } },
  items: { table: 'items', columns: {
    id: 'id', taskId: 'task_id', itemKey: 'item_key', kind: 'kind', path: 'path',
    contentHash: 'content_hash', status: 'status', checkedAt: 'checked_at', checkedBy: 'checked_by'
  } },
  checks: { table: 'checks', columns: {
    id: 'id', taskId: 'task_id', itemKey: 'item_key', result: 'result', by: 'by_user',
    note: 'note', contentHashAtCheck: 'content_hash_at_check', at: 'created_at'
  } },
  signoffs: { table: 'signoffs', columns: {
    id: 'id', taskId: 'task_id', docId: 'doc_id', releaseId: 'release_id', by: 'by_user',
    note: 'note', scope: 'scope', scopeKinds: 'scope_kinds', at: 'created_at'
  } },
  handovers: { table: 'handovers', columns: {
    id: 'id', docId: 'doc_id', fromOwnerId: 'from_owner_id', toOwnerId: 'to_owner_id',
    openTaskIds: 'open_task_ids', reason: 'reason', by: 'by_user', at: 'created_at'
  } },
  evidence: { table: 'evidence', columns: {
    id: 'id', checkId: 'check_id', signoffId: 'signoff_id', taskId: 'task_id',
    kind: 'kind', ref: 'ref', sha256: 'sha256', by: 'by_user', at: 'created_at'
  } },
  contentVersions: { table: 'content_versions', columns: {
    id: 'id', docId: 'doc_id', kind: 'kind', path: 'path', hash: 'hash',
    releaseId: 'release_id', at: 'created_at'
  } },
  reminders: { table: 'reminders', columns: {
    id: 'id', taskId: 'task_id', windowStart: 'window_start', windowEnd: 'window_end',
    overdue: 'overdue', daysLeft: 'days_left', reasons: 'reasons',
    runCount: 'run_count', lastRerunAt: 'last_rerun_at', at: 'created_at'
  } },
  idempotency: { table: 'idempotency', columns: { id: 'id', key: 'key', refId: 'ref_id', createdAt: 'created_at' } },
  auditLogs: { table: 'audit_logs', columns: { id: 'id', action: 'action', payload: 'payload', at: 'created_at' } }
}

// 时间字段（引擎使用 epoch ms；PG 存 timestamptz）
const TS_FIELDS = new Set([
  'createdAt', 'publishedAt', 'dueDate', 'latestReminderAt', 'completedAt', 'supersededAt',
  'checkedAt', 'at', 'windowStart', 'windowEnd', 'lastRerunAt'
])
// jsonb 字段按 “实体.字段” 精确标注（reasons 在 tasks 是 text[]，在 reminders 是 jsonb）
const JSONB_FIELDS = new Set([
  'triggers.causedBy',
  'signoffs.scope',
  'reminders.reasons',
  'auditLogs.payload'
])

function toDBValue(entity, col, value) {
  if (value === null || value === undefined) return null
  if (TS_FIELDS.has(col)) return new Date(value)
  if (JSONB_FIELDS.has(`${entity}.${col}`) && typeof value === 'object') return JSON.stringify(value)
  return value
}

function fromDBRow(entity, columns, row) {
  if (!row) return null
  const out = {}
  for (const [js, db] of Object.entries(columns)) {
    if (!db) continue
    let v = row[db]
    if (TS_FIELDS.has(js) && v != null) v = new Date(v).getTime()
    if (JSONB_FIELDS.has(`${entity}.${js}`) && typeof v === 'string') v = JSON.parse(v)
    out[js] = v
  }
  return out
}

export class PgRepo {
  constructor({ connectionString, pool } = {}) {
    this.connectionString = connectionString
    this._pool = pool || null
    this._ids = new Map()
  }

  async _pg() {
    if (!this._pgModule) {
      try {
        this._pgModule = await import('pg')
      } catch (e) {
        throw new Error('pg driver not installed. Run `npm i pg` or use MemoryRepo for tests/demo.')
      }
    }
    return this._pgModule.default
  }

  async init() {
    const pg = await this._pg()
    this._pool = this._pool || new pg.Pool({ connectionString: this.connectionString })
    const sql = fs.readFileSync(path.resolve(__dirname, '../db/schema.sql'), 'utf8')
    await this._pool.query(sql)
  }

  async close() { await this._pool?.end() }

  async query(text, params = []) {
    return this._pool.query(text, params)
  }

  async tx(fn) {
    const client = await this._pool.connect()
    try {
      await client.query('BEGIN')
      const txRepo = new PgTxRepo(client, this)
      const result = await fn(txRepo)
      await client.query('COMMIT')
      return result
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  // 非事务路径（runReminders / buildManifest 等只读或独立写入）也走 pool
  _client() { return makeClientRepo(this._pool, false) }

  async put(entity, record) { return this._client().put(entity, record) }
  async get(entity, id) { return this._client().get(entity, id) }
  async update(entity, id, patch) { return this._client().update(entity, id, patch) }
  async list(entity, predicate) { return this._client().list(entity, predicate) }
  async find(entity, predicate) { return this._client().find(entity, predicate) }
  async acquireIdempotency(key, onMiss) { return this.tx((t) => t.acquireIdempotency(key, onMiss)) }
  async appendSignoff(row) { return this.put('signoffs', row) }
  async appendHandover(row) { return this.put('handovers', row) }
  async appendEvidence(row) { return this.put('evidence', row) }
  async appendReminder(row) { return this.put('reminders', row) }
  async appendAudit(row) { return this.put('auditLogs', row) }
}

function makeClientRepo(executor, isClient) {
  return new PgTxRepo(executor, null, isClient)
}

// 由内存仓储的接口形状驱动；predicate 在应用层过滤（表数据量可控）。
class PgTxRepo {
  constructor(executor, root, isClient = true) {
    this.executor = executor
    this.root = root
    this.isClient = isClient
    this._seq = 0
  }

  async _q(text, params) {
    if (this.isClient) return this.executor.query(text, params)
    return this.executor.query(text, params)
  }

  _genId(entity) {
    this._seq += 1
    const prefix = ({ users: 'usr', groups: 'grp', docs: 'doc', releases: 'rel',
      triggers: 'trg', tasks: 'tas', items: 'itm', checks: 'chk', signoffs: 'sig',
      handovers: 'han', evidence: 'evd', contentVersions: 'ver', reminders: 'rem',
      idempotency: 'idem', auditLogs: 'aud', groupMembers: 'gm' })[entity] || 'row'
    return `${prefix}_${Date.now().toString(36)}_${this._seq}`
  }

  async put(entity, record) {
    const conf = TABLES[entity]
    if (!conf) throw new Error(`unknown entity: ${entity}`)
    const row = { ...record }
    if (!row.id) {
      if (entity === 'groupMembers') row.id = `${row.groupId}:${row.userId}`
      else row.id = this._genId(entity)
    }
    const entries = Object.entries(conf.columns).filter(([js]) => js !== 'id' && row[js] !== undefined)
    const cols = ['id', ...entries.map(([, db]) => db)]
    const vals = [row.id, ...entries.map(([js]) => toDBValue(entity, js, row[js]))]
    const ph = vals.map((_, i) => `$${i + 1}`)

    // upsert（idempotency / items 带额外唯一键冲突时也按 id 处理）
    const updates = cols.slice(1).map((c) => `${c}=EXCLUDED.${c}`)
    const sql = `INSERT INTO ${conf.table} (${cols.join(',')}) VALUES (${ph.join(',')})
                 ON CONFLICT (id) DO UPDATE SET ${updates.join(',')} RETURNING *`
    const { rows } = await this._q(sql, vals)
    return fromDBRow(entity, conf.columns, rows[0])
  }

  async get(entity, id) {
    const conf = TABLES[entity]
    const { rows } = await this._q(`SELECT * FROM ${conf.table} WHERE id=$1`, [id])
    return fromDBRow(entity, conf.columns, rows[0])
  }

  async update(entity, id, patch) {
    const conf = TABLES[entity]
    const sets = []
    const vals = []
    let i = 1
    for (const [js, db] of Object.entries(conf.columns)) {
      if (js === 'id' || patch[js] === undefined) continue
      sets.push(`${db}=$${i++}`)
      vals.push(toDBValue(entity, js, patch[js]))
    }
    if (!sets.length) return this.get(entity, id)
    vals.push(id)
    const { rows } = await this._q(
      `UPDATE ${conf.table} SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals)
    return fromDBRow(entity, conf.columns, rows[0])
  }

  async list(entity, predicate) {
    const conf = TABLES[entity]
    const orderBy = conf.columns.createdAt || conf.columns.at || 'id'
    const { rows } = await this._q(`SELECT * FROM ${conf.table} ORDER BY ${orderBy} ASC`)
    const mapped = rows.map((r) => fromDBRow(entity, conf.columns, r))
    return predicate ? mapped.filter(predicate) : mapped
  }

  async find(entity, predicate) {
    const rows = await this.list(entity, predicate)
    return rows[0] || null
  }

  async acquireIdempotency(key, onMiss) {
    // 先查命中；未命中执行 onMiss 再登记。唯一索引兜底并发重复。
    const existing = await this.find('idempotency', (r) => r.key === key)
    if (existing) return { hit: true, refId: existing.refId, record: existing }
    const ref = await onMiss()
    let record
    try {
      record = await this.put('idempotency', { id: this._genId('idempotency'), key, refId: ref.id, createdAt: Date.now() })
    } catch (e) {
      const again = await this.find('idempotency', (r) => r.key === key)
      if (again) return { hit: true, refId: again.refId, record: again }
      throw e
    }
    return { hit: false, refId: ref.id, record }
  }
}
