// 内存存储：字段与 server/db/schema.sql 中的表一一对应。
// 生产环境替换为 PG 实现（见 repository 层注释），引擎逻辑不依赖具体持久化。

let _id = 0
export function uuid() {
  _id++
  return 'id-' + _id.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

export function createStore() {
  return {
    members: new Map(),            // team_member
    pages: new Map(),              // doc_page
    pagesByPath: new Map(),
    declaredScopes: [],            // page_declared_scope {pageId, pattern}
    handovers: [],                 // owner_handover (append-only)
    handoverSeq: 0,
    releases: new Map(),           // doc_release
    releasePages: [],              // release_page (releaseId,pageId,hash)
    items: new Map(),              // review_item
    revisions: [],                 // review_item_revision
    checks: [],                    // review_check (append-only)
    tasks: new Map(),              // maintenance_task
    taskItems: new Map(),          // task_id -> Set(item_id)
    assignmentLogs: [],            // task_assignment_log (append-only)
    assignmentSeq: 0,
    reminders: [],                 // task_reminder
    signoffs: [],                  // review_signoff (append-only)
    signoffItems: [],              // signoff_item
    evidences: []                  // review_evidence (append-only)
  }
}

// 模拟 PG 的 append-only：证据/签收/检查/交接一经写入不可改
export function freezeAppendOnly(store) {
  for (const arr of ['checks', 'signoffs', 'evidences', 'handovers', 'assignmentLogs']) {
    const list = store[arr]
    const origPush = list.push.bind(list)
    list.push = (...rows) => {
      rows.forEach((r) => Object.freeze(r))
      return origPush(...rows)
    }
  }
}
