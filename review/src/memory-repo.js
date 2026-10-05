// 内存版 ReviewRepository：字段与 PG schema 一一对应，便于离线验收；
// PG 实现以相同方法名编写 SQL（见 sql/001_review_management.sql）。
import { TASK_STATUS, ITEM } from './review-service.js'

export class MemoryReviewRepository {
  constructor() {
    this.docs = new Map()
    this.people = new Map()
    this.scopes = new Map() // docId -> [{id,...}]
    this.tasks = new Map()
    this.mergeIndex = new Map() // mergeKey -> 当前任务对象
    this.ledger = new Map()
    this.ownerHistory = []
    this.claims = []
    this.itemResults = []
    this.contentChanges = []
    this._id = 0
    this._workingClaimByTask = new Map()
  }

  id(prefix) {
    this._id += 1
    return `${prefix}_${this._id}`
  }

  upsertDoc(d) {
    const prev = this.docs.get(d.id) || {}
    const doc = {
      id: d.id,
      revision: d.revision ?? prev.revision ?? '',
      locale: d.locale ?? prev.locale ?? 'zh-CN',
      defaultOwnerId: d.defaultOwnerId ?? prev.defaultOwnerId ?? null,
      updatedAt: d.updatedAt ?? Date.now()
    }
    this.docs.set(d.id, doc)
    return doc
  }
  getDoc(id) { return this.docs.get(id) }
  listDocs() { return [...this.docs.values()] }

  upsertPerson(p) {
    const prev = this.people.get(p.id) || {}
    const person = {
      id: p.id, name: p.name ?? prev.name ?? p.id,
      active: p.active ?? prev.active ?? true,
      teamId: p.teamId ?? prev.teamId ?? null
    }
    this.people.set(p.id, person)
    return person
  }
  getPerson(id) { return id ? this.people.get(id) : null }

  replaceScopes(docId, scopes) {
    this.scopes.set(docId, scopes.map((s) => ({ id: this.id('scp'), ...s })))
    return this.scopes.get(docId)
  }
  listScopes(docId) { return this.scopes.get(docId) || [] }

  hasTrigger(idemKey) { return this.ledger.has(idemKey) }
  recordTrigger(e) {
    // 幂等：已存在则原样返回，不改写 ran_at
    if (this.ledger.has(e.idemKey)) return this.ledger.get(e.idemKey)
    const row = { ...e, taskIds: e.taskIds || [] }
    this.ledger.set(e.idemKey, row)
    return row
  }

  createOrMergeTask(input) {
    const ACTIVE = [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS, TASK_STATUS.STALE]
    const existing = this.mergeIndex.get(input.mergeKey)
    if (existing && ACTIVE.includes(existing.status)) {
      // 合并两类触发（周期扫描 + 依赖变更）：记录来源，不重复建单，不改派已有 owner
      if (!existing.sources.includes(input.via)) existing.sources.push(input.via)
      existing.mergedAt = input.createdAt
      existing.merged = true
      return existing
    }
    // 无活跃单（首次，或上轮已签收/取消）→ 开新一轮并重新占用 mergeKey
    const task = {
      id: this.id('task'),
      docId: input.docId,
      releaseId: input.releaseId,
      status: input.status,
      ownerId: input.ownerId ?? null,
      dueAt: input.dueAt ?? null,
      createdBy: input.createdBy,
      via: input.via,
      sources: [input.via],
      createdAt: input.createdAt,
      round: (existing?.round || 0) + 1,
      merged: false
    }
    this.tasks.set(task.id, task)
    this.mergeIndex.set(input.mergeKey, task)
    return task
  }
  getTask(id) { return this.tasks.get(id) }
  findActiveTask(mergeKey) {
    const t = this.mergeIndex.get(mergeKey)
    return t && [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS, TASK_STATUS.STALE].includes(t.status)
      ? t : null
  }
  listActiveTasks() {
    return [...this.tasks.values()].filter((t) =>
      [TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS, TASK_STATUS.STALE].includes(t.status))
  }

  // 新一轮继承上轮逐项证据；受影响 scope 回到 pending（正文关键变化 → 相关项待重验）
  seedNewRoundFromClaim({ taskId, sourceClaimId, affectedScopeIds, now }) {
    const task = this.getTask(taskId)
    const working = this.workingClaim(taskId)
    const previous = this.itemResults.filter((r) => r.claimId === sourceClaimId)
    const hit = new Set(affectedScopeIds)
    for (const r of previous) {
      const becomesPending = hit.size === 0 || hit.has(r.scopeId)
      this.itemResults.push({
        ...r,
        id: this.id('ir'),
        claimId: working.id,
        taskId,
        result: becomesPending ? ITEM.PENDING : r.result,
        carriedFrom: sourceClaimId,
        invalidatedAt: becomesPending ? now : r.invalidatedAt
      })
    }
    return working
  }
  updateTaskStatus(id, status) { const t = this.getTask(id); if (t) t.status = status }
  updateTaskOwner(id, ownerId) { const t = this.getTask(id); if (t) t.ownerId = ownerId }
  markStale(id) { const t = this.getTask(id); if (t && t.status !== TASK_STATUS.SIGNED) t.status = TASK_STATUS.STALE }

  appendOwnerHistory(h) {
    const row = { id: this.id('oh'), ...h }
    this.ownerHistory.push(row)
    return row
  }

  insertContentChange(c) {
    const row = { id: this.id('cc'), ...c }
    this.contentChanges.push(row)
    return row
  }
  listContentChanges(docId) {
    return this.contentChanges.filter((c) => c.docId === docId).sort((a, b) => a.changedAt - b.changedAt)
  }

  // 每轮任务的草稿签收容器；stale 后重新检查会新建一轮，旧 claim 永久保留
  // 每轮草稿签收容器；carryFromClaimId 存在时从上次留档签收继承已检项证据。
  // （同一任务上一次为部分失败签收，补检后再次签收：未改的项保留，逐项覆盖录入）
  workingClaim(taskId, opts = {}) {
    let w = this._workingClaimByTask.get(taskId)
    const task = this.getTask(taskId)
    if (!w || w.committed) {
      w = { id: this.id('claim'), taskId, docId: task.docId, committed: false }
      this._workingClaimByTask.set(taskId, w)
      if (opts.carryFromClaimId) {
        for (const r of this.itemResults.filter((r) => r.claimId === opts.carryFromClaimId)) {
          this.itemResults.push({ ...r, id: this.id('ir'), claimId: w.id, taskId,
            carriedFrom: opts.carryFromClaimId })
        }
      }
    }
    return w
  }

  upsertItemResult(input) {
    const list = this.itemResults.filter(
      (r) => r.claimId === input.claimId && r.scopeId === input.scopeId)
    if (list.length) {
      Object.assign(list[0], input)
      return list[0]
    }
    const row = { id: this.id('ir'), ...input }
    this.itemResults.push(row)
    return row
  }
  listItemResults(claimId) {
    return this.itemResults.filter((r) => r.claimId === claimId)
  }

  commitClaim(input) {
    const w = this._workingClaimByTask.get(input.taskId)
    const claim = {
      id: w ? w.id : input.id,
      taskId: input.taskId, docId: input.docId, releaseId: input.releaseId,
      signedBy: input.signedBy, signedByName: input.signedByName,
      signedAt: input.signedAt, docRevision: input.docRevision,
      scopeFingerprint: input.scopeFingerprint, fullScope: input.fullScope, note: input.note
    }
    this.claims.push(claim)
    if (w) { w.committed = true; this._workingClaimByTask.delete(input.taskId) }
    return claim
  }

  latestClaimForTask(taskId) {
    const list = this.claims.filter((c) => c.taskId === taskId)
    return list.length ? list[list.length - 1] : null
  }
  latestClaimAny(docId) {
    const list = this.claims.filter((c) => c.docId === docId)
    return list.length ? list[list.length - 1] : null
  }
  latestFullClaim(docId) {
    const list = this.claims.filter((c) => c.docId === docId && c.fullScope)
    return list.length ? list[list.length - 1] : null
  }

  invalidateItemResults(taskId, scopeIds, now) {
    const claim = this.latestClaimForTask(taskId)
    if (!claim) return
    const hit = new Set(scopeIds)
    for (const r of this.itemResults) {
      if (r.claimId === claim.id && hit.has(r.scopeId)) {
        // 不删除证据，只打回 pending 待重验（历史可读）
        r.result = ITEM.PENDING
        r.invalidatedAt = now
      }
    }
  }
}
