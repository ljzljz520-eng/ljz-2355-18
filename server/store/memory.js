// 内存仓储：与 PG 仓储实现同一接口，供单测 / Demo 使用。
// 所有写操作都返回深拷贝，避免调用方意外篡改历史（签收/交接/证据均 append-only）。

const ENTITIES = [
  'users', 'groups', 'groupMembers', 'docs', 'releases', 'triggers',
  'tasks', 'items', 'checks', 'signoffs', 'handovers',
  'evidence', 'contentVersions', 'reminders', 'idempotency', 'auditLogs'
]

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v))
}

export class MemoryRepo {
  constructor() {
    this.reset()
  }

  reset() {
    for (const e of ENTITIES) this[e] = new Map()
    this._seq = 0
  }

  async init() { /* noop */ }
  async tx(fn) { return fn(this) }

  _id(prefix) {
    this._seq += 1
    return `${prefix}_${this._seq}`
  }

  // ---- generic -----------------------------------------------------------
  async put(entity, record) {
    if (!record.id) record.id = this._id(entity.slice(0, 3))
    this[entity].set(record.id, clone(record))
    return clone(record)
  }

  async get(entity, id) {
    const r = this[entity].get(id)
    return r ? clone(r) : null
  }

  async update(entity, id, patch) {
    const cur = this[entity].get(id)
    if (!cur) return null
    const next = { ...cur, ...patch, id }
    this[entity].set(id, next)
    return clone(next)
  }

  async list(entity, predicate) {
    const rows = [...this[entity].values()].map(clone)
    return predicate ? rows.filter(predicate) : rows
  }

  async find(entity, predicate) {
    const rows = await this.list(entity, predicate)
    return rows[0] || null
  }

  // ---- idempotency -------------------------------------------------------
  // 在事务内“先查后插”。键上有唯一约束（PG 侧为 UNIQUE INDEX）。
  async acquireIdempotency(key, onMiss) {
    const existing = this.idempotency.get(key)
    if (existing) return { hit: true, refId: existing.refId, record: clone(existing) }
    const ref = await onMiss()
    const record = { id: this._id('idem'), key, refId: ref.id, createdAt: Date.now() }
    this.idempotency.set(key, record)
    return { hit: false, refId: ref.id, record: clone(record) }
  }

  // ---- appends ------------------------------------------------------------
  async appendSignoff(row) { return this.put('signoffs', { ...row, at: row.at ?? Date.now() }) }
  async appendHandover(row) { return this.put('handovers', { ...row, at: row.at ?? Date.now() }) }
  async appendEvidence(row) { return this.put('evidence', { ...row, at: row.at ?? Date.now() }) }
  async appendReminder(row) { return this.put('reminders', { ...row, at: row.at ?? Date.now() }) }
  async appendAudit(row) { return this.put('auditLogs', { ...row, at: row.at ?? Date.now() }) }
}
