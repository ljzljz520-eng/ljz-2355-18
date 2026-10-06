/**
 * PostgreSQL 仓储（生产实现）。
 *
 * 配合 ../schema.sql 建表使用；表结构保留了：
 *  - review_signoffs（签收证据，含 signed_by，任何转派都不会改写）
 *  - review_handovers（责任交接链）
 *  - review_task_triggers（周期/依赖/转派触发明细，合并与幂等判定依据）
 *  - review_evidence（通用审阅证据：检查截图、签收快照）
 *
 * 依赖 `pg`（package.json 中为可选依赖；本地自测走 JsonRepo，无需安装/启动 PG）。
 * 连接与集合的映射见 collectionTable()。数组/jsonb 字段由 JSONB 承载，
 * 领域服务仍只操作普通 JS 对象，因此 JsonRepo / PgRepo 可互换。
 */
export class PgRepo {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool
  }

  static async connect(connectionString) {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString })
    await pool.query('SELECT 1')
    return new PgRepo(pool)
  }

  #table(coll) {
    const map = {
      users: 'review_users',
      docs: 'review_docs',
      releases: 'review_releases',
      checkItems: 'review_check_items',
      tasks: 'review_tasks',
      signoffs: 'review_signoffs',
      handovers: 'review_handovers',
      reminders: 'review_reminders',
      evidence: 'review_evidence'
    }
    if (!map[coll]) throw new Error(`未知集合: ${coll}`)
    return map[coll]
  }

  #jsonbFields = {
    review_releases: ['blocks', 'declared_scope', 'last_public_date_meta'],
    review_check_items: ['covers', 'evidence', 'revalidate'],
    review_tasks: ['triggers'],
    review_signoffs: ['scope', 'checks_passed'],
    review_handovers: ['affected_doc_ids', 'affected_task_ids'],
    review_evidence: ['payload']
  }

  async get(coll, id) {
    const table = this.#table(coll)
    const { rows } = await this.pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id])
    return rows[0] ? this.#fromRow(table, rows[0]) : null
  }

  async list(coll) {
    const table = this.#table(coll)
    const { rows } = await this.pool.query(`SELECT * FROM ${table}`)
    return rows.map(r => this.#fromRow(table, r))
  }

  async put(coll, id, value) {
    // upsert：以领域对象的 key 映射为列；新增集合时在此登记列映射即可
    const table = this.#table(coll)
    const { columns, values, placeholders } = this.#toColumns(table, { id, ...value })
    const updates = columns.filter(c => c !== 'id')
      .map((c, i) => `${c} = $${i + 2}`).join(', ')
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
                 ON CONFLICT (id) DO UPDATE SET ${updates}`
    await this.pool.query(sql, values)
  }

  #toColumns(table, obj) {
    const columns = []
    const values = []
    for (const [key, val] of Object.entries(obj)) {
      const col = camelToSnake(key)
      columns.push(col)
      values.push(this.#jsonbFields[table]?.includes(col) && val != null ? JSON.stringify(val) : val)
    }
    return { columns, values, placeholders: columns.map((_, i) => `$${i + 1}`).join(', ') }
  }

  #fromRow(table, row) {
    const out = {}
    for (const [key, val] of Object.entries(row)) {
      const camel = snakeToCamel(key)
      out[camel] = this.#jsonbFields[table]?.includes(key) && typeof val === 'string' ? JSON.parse(val) : val
    }
    return out
  }
}

function camelToSnake(s) { return s.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`) }
function snakeToCamel(s) { return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) }
