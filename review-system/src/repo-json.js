import fs from 'node:fs'
import path from 'node:path'

export const COLLECTIONS = [
  'users', 'docs', 'releases', 'checkItems', 'tasks',
  'signoffs', 'handovers', 'reminders', 'evidence'
]

/** 零依赖 JSON 文件仓储：接口与 PgRepo 完全一致，供本地自测与 demo 使用。 */
export class JsonRepo {
  constructor(file) {
    this.file = file
    this.data = Object.fromEntries(COLLECTIONS.map(c => [c, {}]))
    if (file && fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf-8'))
      for (const c of COLLECTIONS) this.data[c] ??= {}
    }
  }

  get(coll, id) { return this.data[coll][id] ? structuredClone(this.data[coll][id]) : null }
  list(coll) { return Object.values(this.data[coll]).map(v => structuredClone(v)) }
  put(coll, id, value) { this.data[coll][id] = structuredClone(value); this.#save() }

  #save() {
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
