// ============================================================================
// 产品文档复审管理 —— 后台领域服务（参考实现）
//
// 通过 ReviewRepository 接口持久化（PG 实现见 sql/，测试使用内存实现）。
// 所有时刻均为 epoch 毫秒；clock 可注入以便测试。
//
// 核心不变量：
//   A. 周期扫描(periodic_scan) 与 依赖变更(dependency_change) 用同一 merge_key
//      合并为一条活跃任务；trigger 台账保证重复触发幂等。
//   B. 转派只改"待办"任务的 owner，并向 owner_history 追加一条；
//      已签收 claim.signed_by 永不被覆盖。
//   C. 签收允许部分 item fail；fullScope 仅当全部必检项非 pending。
//      公开日期只来自 fullScope=true 的最近签收（真实完成范围）。
//   D. 正文关键变化：受影响 item 在新任务上回到 pending；旧任务转 stale，
//      旧签收与公开内容保留（只提示信息需核实，不撤历史可读内容）。
//   E. 检查了一处示例 ≠ 整篇：scope 覆盖必须满足声明范围，逐项证据缺失即不算完整。
// ============================================================================
import { zonedDate, zonedDayStart } from './time.js'

export const TASK_STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  SIGNED: 'signed',
  STALE: 'stale',
  CANCELLED: 'cancelled'
}

export const ITEM = { PENDING: 'pending', PASS: 'pass', FAIL: 'fail' }

export const TRIGGER = { PERIODIC: 'periodic_scan', DEPENDENCY: 'dependency_change' }

export function scopeFingerprint(scopes) {
  // 声明范围指纹：kind+ref+dep_fingerprint 的稳定集合摘要
  const basis = scopes
    .map((s) => `${s.kind}|${s.ref}|${s.dep_fingerprint || ''}`)
    .sort()
    .join('\n')
  let h = 5381
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0
  return `sfp_${h.toString(16)}_${scopes.length}`
}

function mergeKey(docId, releaseId) {
  return `${docId}@${releaseId}`
}

export class ReviewService {
  /**
   * @param {object} repo ReviewRepository（PG/内存）
   * @param {object} opts { now?:()=>number, reviewWindowDays?:number, siteZone?:string }
   */
  constructor(repo, opts = {}) {
    this.repo = repo
    this.now = opts.now || (() => Date.now())
    this.reviewWindowDays = opts.reviewWindowDays ?? 90
    this.siteZone = opts.siteZone || 'Asia/Shanghai'
  }

  // -------------------------------------------------------------------------
  // 文档 / 人员 / 范围维护
  // -------------------------------------------------------------------------
  upsertDoc({ id, revision = '', locale = 'zh-CN', defaultOwnerId = undefined }) {
    const patch = { id, revision, locale, updatedAt: this.now() }
    if (defaultOwnerId !== undefined) patch.defaultOwnerId = defaultOwnerId
    return this.repo.upsertDoc(patch)
  }

  // 默认截止：当前站点时区的 (今天 + 复审窗口) 07:00
  defaultDueAt(now = this.now()) {
    const day = zonedDate(now, this.siteZone)
    return zonedDayStart(shiftDate(day, this.reviewWindowDays), this.siteZone) + 7 * 3600000
  }

  upsertPerson({ id, name, active = true, teamId = null }) {
    return this.repo.upsertPerson({ id, name, active, teamId })
  }

  setPersonActive(personId, active) {
    const p = this.repo.getPerson(personId)
    if (!p) throw new Error(`unknown person: ${personId}`)
    return this.repo.upsertPerson({ ...p, active })
  }

  /**
   * 同步文档的声明范围（图必须满足声明范围）。
   * 返回时也会校验：调用方可用 assertCoverageSatisfiesClaim 校验覆盖图。
   */
  syncScopes(docId, scopes) {
    const doc = this.requireDoc(docId)
    const normalized = scopes.map((s) => ({
      docId,
      kind: s.kind,
      ref: s.ref,
      label: s.label || s.ref,
      required: s.required !== false,
      depFingerprint: s.depFingerprint || ''
    }))
    return this.repo.replaceScopes(docId, normalized)
  }

  requireDoc(docId) {
    const doc = this.repo.getDoc(docId)
    if (!doc) throw new Error(`unknown doc: ${docId}`)
    return doc
  }

  // -------------------------------------------------------------------------
  // 后台入口一：固定周期扫描（每个发布版为每篇到期文档生成/复用维护任务）
  // -------------------------------------------------------------------------
  /**
   * @param {string} scanId 本轮扫描逻辑 id（如周期 yyyy-mm-dd@release）
   *        —— 同一 scanId 重跑完全幂等。
   */
  periodicScan({ releaseId, scanId, docIds = null, dueInDays = null, baseDate = null }) {
    const idemKey = `scan:${scanId}:${releaseId}`
    if (this.repo.hasTrigger(idemKey)) {
      return { skipped: true, idempotencyKey: idemKey, tasks: [] }
    }
    const now = this.now()
    const zone = this.siteZone
    const day = baseDate || zonedDate(now, zone)
    const dueDay = dueInDays == null
      ? null
      : shiftDate(day, dueInDays ?? this.reviewWindowDays)
    const dueAt = dueDay ? zonedDayStart(dueDay, zone) + 7 * 3600 * 1000 : null // 当日 07:00 本地

    const docs = docIds ? docIds.map((id) => this.requireDoc(id)) : this.repo.listDocs()
    const tasks = []
    for (const doc of docs) {
      if (this.isDocFresh(doc, now)) continue // 范围内已完整复审 → 无需新任务
      const t = this.repo.createOrMergeTask({
        docId: doc.id,
        releaseId,
        status: TASK_STATUS.OPEN,
        ownerId: doc.defaultOwnerId || null,
        dueAt,
        createdBy: 'system',
        via: TRIGGER.PERIODIC,
        mergeKey: mergeKey(doc.id, releaseId),
        createdAt: now
      })
      tasks.push(t)
    }
    this.repo.recordTrigger({
      idemKey, kind: TRIGGER.PERIODIC, ref: scanId,
      taskIds: tasks.map((t) => t.id), payloadHash: `${day}`, ranAt: now
    })
    return { skipped: false, idempotencyKey: idemKey, tasks }
  }

  isDocFresh(doc, now) {
    const last = this.repo.latestFullClaim(doc.id)
    if (!last) return false
    return now - last.signedAt < this.reviewWindowDays * 86400000
  }

  // -------------------------------------------------------------------------
  // 后台入口二：按依赖变更触发（正文关键变化 / 上游变更）
  //   受影响 item 待重验；与同 release 的周期任务合并，不重复建单。
  // -------------------------------------------------------------------------
  dependencyChanged({ eventId, docId, releaseId, newRevision, affectedScopeRefs = null,
                      summary = '', changeKind = 'dependency' }) {
    const idemKey = `dep:${eventId}`
    if (this.repo.hasTrigger(idemKey)) {
      return { skipped: true, idempotencyKey: idemKey }
    }
    const doc = this.requireDoc(docId)
    const now = this.now()

    // 登记正文/依赖变化（供公开视图判定 needs_verification）
    const scopes = this.repo.listScopes(docId)
    let affectedIds = null
    if (affectedScopeRefs && affectedScopeRefs.length) {
      affectedIds = scopes
        .filter((s) => affectedScopeRefs.includes(s.ref))
        .map((s) => s.id)
    }
    this.repo.insertContentChange({
      docId, revision: newRevision || doc.revision, changedAt: now,
      changeKind, affectedScopeIds: affectedIds || [], summary
    })
    if (newRevision) this.repo.upsertDoc({ ...doc, revision: newRevision, updatedAt: now })

    // 现有"活跃"任务（open/in_progress/stale）：相关项打回 pending；破坏完整覆盖则 stale
    const active = this.repo.findActiveTask(mergeKey(docId, releaseId))
    let sourceClaimId = null
    let prevTaskDueAt = null
    if (active) {
      const invalidate = this.scopesToInvalidate(docId, affectedScopeRefs)
      if (this.invalidationBreaksCoverage(active, invalidate)) {
        this.repo.markStale(active.id, now)
      }
      this.repo.invalidateItemResults(active.id, invalidate, now)
      sourceClaimId = this.repo.latestClaimForTask(active.id)?.id || null
    } else {
      // 上一轮已签收：历史 claim 作为 carry-forward 来源（证据永久保留）
      const prevClaim = this.repo.latestClaimAny(docId)
      sourceClaimId = prevClaim?.id || null
      if (prevClaim) prevTaskDueAt = this.repo.getTask(prevClaim.taskId)?.dueAt ?? null
    }

    // 合并建单（周期扫描已建活跃单则复用 → 两类任务合并；上轮已签收则开新一轮）
    const task = this.repo.createOrMergeTask({
      docId,
      releaseId,
      status: TASK_STATUS.OPEN,
      ownerId: active?.ownerId ?? doc.defaultOwnerId ?? null,
      dueAt: active?.dueAt ?? prevTaskDueAt ?? this.defaultDueAt(now),
      createdBy: 'system',
      via: TRIGGER.DEPENDENCY,
      mergeKey: mergeKey(docId, releaseId),
      createdAt: now
    })

    // 新一轮继承上轮证据，但受影响 scope 回到 pending（待重验）
    if (!active && sourceClaimId) {
      this.repo.seedNewRoundFromClaim({
        taskId: task.id, sourceClaimId,
        affectedScopeIds: this.scopesToInvalidate(docId, affectedScopeRefs),
        now
      })
    }

    this.repo.recordTrigger({
      idemKey, kind: TRIGGER.DEPENDENCY, ref: eventId,
      taskIds: [task.id], payloadHash: newRevision || '', ranAt: now
    })
    return { skipped: false, idempotencyKey: idemKey, task, mergedWithActive: !!active,
             newRound: !active && !!sourceClaimId }
  }

  scopesToInvalidate(docId, affectedScopeRefs) {
    const scopes = this.repo.listScopes(docId)
    if (!affectedScopeRefs) return scopes.map((s) => s.id) // 未指明=全部待重验
    const set = new Set(affectedScopeRefs)
    return scopes.filter((s) => set.has(s.ref)).map((s) => s.id)
  }

  invalidationBreaksCoverage(task, scopeIds) {
    if (!scopeIds.length) return false
    const claim = this.repo.latestClaimForTask(task.id)
    if (!claim || !claim.fullScope) return !!claim // 已不完整则状态切 stale 提示重验
    const results = this.repo.listItemResults(claim.id)
    const hit = new Set(scopeIds)
    // 被失效的若包含 required 项，则完整覆盖被打破
    const scopes = this.repo.listScopes(task.docId)
    return scopes.some((s) => hit.has(s.id) && s.required)
  }

  // -------------------------------------------------------------------------
  // 负责人离职 / 小组调整：转派"待办"，不动历史签收
  // -------------------------------------------------------------------------
  /**
   * @param toOwnerId 新负责人；传 null = 暂无继任负责人（待办悬空，仍可查可见）
   * @param scope { personId? } 转派某人当前全部待办；{ teamId? } 整组调整；
   *              { taskIds? } 指定任务
   */
  reassignOpenTodos({ fromOwnerId = null, teamId = null, taskIds = null, toOwnerId,
                      reason = 'manual', changedBy = 'system' }) {
    if (toOwnerId) {
      const p = this.repo.getPerson(toOwnerId)
      if (!p || !p.active) throw new Error(`cannot assign to ${toOwnerId}: 不存在或已离职`)
    }
    const now = this.now()
    let tasks = this.repo.listActiveTasks()
    if (taskIds) {
      const ids = new Set(taskIds)
      tasks = tasks.filter((t) => ids.has(t.id))
    }
    if (fromOwnerId) tasks = tasks.filter((t) => t.ownerId === fromOwnerId)
    if (teamId) {
      tasks = tasks.filter((t) => {
        const p = t.ownerId && this.repo.getPerson(t.ownerId)
        return p && p.teamId === teamId
      })
    }
    const history = []
    for (const t of tasks) {
      const from = t.ownerId
      this.repo.updateTaskOwner(t.id, toOwnerId)
      history.push(this.repo.appendOwnerHistory({
        taskId: t.id, docId: t.docId, releaseId: t.releaseId,
        fromOwner: from, toOwner: toOwnerId, reason, changedBy, changedAt: now
      }))
    }
    // 关键：签收人不被覆盖 —— 这里完全不触碰 doc_review_claims.signed_by
    return { reassigned: tasks.length, history }
  }

  // -------------------------------------------------------------------------
  // 逐项审阅（检查了一处示例，只记一项；不代表整篇）
  // -------------------------------------------------------------------------
  recordItemCheck({ taskId, scopeRef, result, checker, evidence = '', failReason = '' }) {
    const task = this.repo.getTask(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    if (![TASK_STATUS.OPEN, TASK_STATUS.IN_PROGRESS, TASK_STATUS.STALE].includes(task.status)) {
      throw new Error(`task ${taskId} 已结束(${task.status})，不可再录入检查项`)
    }
    const scope = this.repo.listScopes(task.docId).find((s) => s.ref === scopeRef)
    if (!scope) throw new Error(`scope not in claim range: ${scopeRef}（不在声明范围内）`)
    if (task.status === TASK_STATUS.OPEN || task.status === TASK_STATUS.STALE) {
      this.repo.updateTaskStatus(taskId, TASK_STATUS.IN_PROGRESS)
    }
    const now = this.now()
    // 依赖/正文变化已由 dependencyChanged 把相关项打回 pending（待重验）；
    // 若上一次是"部分失败签收"，补检时从该留档签收继承其余项证据。
    const priorCommitted = this.repo.latestClaimForTask(taskId)
    const working = this.repo.workingClaim(taskId,
      priorCommitted ? { carryFromClaimId: priorCommitted.id } : {})
    return this.repo.upsertItemResult({
      claimId: working.id, taskId, scopeId: scope.id, result,
      checker, evidence, failReason, checkedFingerprint: scope.depFingerprint, checkedAt: now
    })
  }

  // -------------------------------------------------------------------------
  // 签收：允许部分失败；页面在签收时更新；只有完整覆盖才推进公开日期
  // -------------------------------------------------------------------------
  signOff({ taskId, checker, note = '' }) {
    const task = this.repo.getTask(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    const doc = this.requireDoc(task.docId)
    const working = this.repo.workingClaim(taskId)
    const scopes = this.repo.listScopes(task.docId)
    const required = scopes.filter((s) => s.required)
    const results = this.repo.listItemResults(working.id)
    const byScope = new Map(results.map((r) => [r.scopeId, r]))

    const missing = required.filter((s) => !byScope.has(s.id) || byScope.get(s.id).result === ITEM.PENDING)
    const failures = required.filter((s) => byScope.get(s.id)?.result === ITEM.FAIL)
    // 公开日期反映真实完成范围：必须声明范围全部 PASS（部分失败可签收但不推进公开日期）
    const fullScope = missing.length === 0 && failures.length === 0
    const now = this.now()

    const person = this.repo.getPerson(checker)
    const claim = this.repo.commitClaim({
      id: working.id,
      taskId, docId: task.docId, releaseId: task.releaseId,
      signedBy: checker,
      signedByName: person?.name || checker,
      signedAt: now,
      docRevision: doc.revision, // 签收时页面更新：锚定当前正文版本
      scopeFingerprint: scopeFingerprint(scopes),
      fullScope,
      note
    })
    // 仅完整覆盖才关闭本轮；部分失败/缺项的签收留档但任务保持处理中
    this.repo.updateTaskStatus(taskId, fullScope ? TASK_STATUS.SIGNED : TASK_STATUS.IN_PROGRESS)
    return {
      claim,
      fullScope,
      missing: missing.map((s) => s.ref),
      failures: failures.map((s) => ({ ref: s.ref, reason: byScope.get(s.id).failReason }))
    }
  }

  // -------------------------------------------------------------------------
  // 到期处置：只提示"信息需核实"，绝不撤历史可读内容
  // -------------------------------------------------------------------------
  expireDue(now = this.now()) {
    const tasks = this.repo.listActiveTasks().filter(
      (t) => t.dueAt != null && t.dueAt < now && t.status !== TASK_STATUS.STALE
    )
    for (const t of tasks) this.repo.updateTaskStatus(t.id, TASK_STATUS.STALE)
    return tasks.map((t) => t.id)
  }

  // -------------------------------------------------------------------------
  // 提醒任务（重跑幂等）：同一到期窗口只提醒一次
  // -------------------------------------------------------------------------
  runDueReminders({ batchId, now = this.now() }) {
    const idemKey = `reminder:${batchId}`
    if (this.repo.hasTrigger(idemKey)) return { skipped: true, sent: [] }
    const sent = []
    for (const t of this.repo.listActiveTasks()) {
      if (t.dueAt == null || t.dueAt >= now) continue
      const key = `reminder:task:${t.id}:${zonedDate(t.dueAt, this.siteZone)}`
      if (this.repo.hasTrigger(key)) continue
      this.repo.recordTrigger({
        idemKey: key, kind: t.via || TRIGGER.PERIODIC, ref: batchId,
        taskIds: [t.id], payloadHash: '', ranAt: now
      })
      sent.push({ taskId: t.id, ownerId: t.ownerId, dueAt: t.dueAt })
    }
    this.repo.recordTrigger({ idemKey, kind: TRIGGER.PERIODIC, ref: batchId,
      taskIds: sent.map((s) => s.taskId), payloadHash: '', ranAt: now })
    return { skipped: false, sent }
  }

  // -------------------------------------------------------------------------
  // 覆盖图校验：覆盖必须满足声明范围（多出来的覆盖项无害，缺项不行）
  // -------------------------------------------------------------------------
  assertCoverageSatisfiesClaim(docId, coveredRefs) {
    const scopes = this.repo.listScopes(docId).filter((s) => s.required)
    const covered = new Set(coveredRefs)
    const uncovered = scopes.filter((s) => !covered.has(s.ref)).map((s) => ({
      ref: s.ref, kind: s.kind, label: s.label
    }))
    return { satisfies: uncovered.length === 0, uncovered }
  }

  // -------------------------------------------------------------------------
  // 公开页脚：负责人 / 校验范围 / 日期（日期反映真实完成范围）
  // -------------------------------------------------------------------------
  getPublicFooter(docId, now = this.now()) {
    const doc = this.requireDoc(docId)
    const lastFull = this.repo.latestFullClaim(docId)
    const active = this.repo.listActiveTasks().filter((t) => t.docId === docId)
    const changedAfter = lastFull
      ? this.repo.listContentChanges(docId).filter((c) => c.changedAt > lastFull.signedAt)
      : []
    // 到期只提示"信息需核实"：stale 或已过 dueAt；历史签收/日期照旧可读
    const overdue = active.some((t) => t.status === TASK_STATUS.STALE ||
      (t.dueAt != null && t.dueAt < now))

    let pageState = 'never_reviewed'
    if (lastFull) pageState = (changedAfter.length || overdue) ? 'needs_verification' : 'current'

    return {
      docId,
      pageState,
      owner: lastFull ? { id: lastFull.signedBy, name: lastFull.signedByName } : null,
      scope: lastFull ? { fingerprint: lastFull.scopeFingerprint } : null,
      signedAt: lastFull?.signedAt || null, // 公开日期：仅完整覆盖签收
      hasHistory: !!this.repo.latestClaimAny(docId),
      todo: active.map((t) => ({
        taskId: t.id, ownerId: t.ownerId, status: t.status, dueAt: t.dueAt
      })),
      overdue,
      contentChangedAfterSign: changedAfter.length
    }
  }

  // 维护者视角：为何超期（而非只有黄色标签）
  getOverdueDetail(taskId, now = this.now()) {
    const task = this.repo.getTask(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    const scopes = this.repo.listScopes(task.docId)
    const claim = this.repo.latestClaimForTask(taskId) || this.repo.workingClaim(taskId)
    const results = this.repo.listItemResults(claim.id)
    const byScope = new Map(results.map((r) => [r.scopeId, r]))
    const items = scopes.map((s) => {
      const r = byScope.get(s.id)
      return {
        ref: s.ref, label: s.label, required: s.required,
        result: r?.result || ITEM.PENDING,
        failReason: r?.failReason || '',
        evidence: r?.evidence || ''
      }
    })
    const reasons = []
    if (task.status === TASK_STATUS.STALE && task.dueAt && task.dueAt < now) {
      reasons.push(`已超过复审截止 ${new Date(task.dueAt).toISOString().slice(0, 10)}`)
    }
    const owner = task.ownerId ? this.repo.getPerson(task.ownerId) : null
    if (!owner || owner.active === false) {
      reasons.push(owner === null ? '无继任负责人，待办悬空' : `负责人 ${owner.name} 已离职`)
    }
    const failed = items.filter((i) => i.result === ITEM.FAIL)
    failed.forEach((i) => reasons.push(`「${i.label}」检查失败：${i.failReason || '未填写原因'}`))
    const pending = items.filter((i) => i.required && i.result === ITEM.PENDING)
    if (pending.length) reasons.push(`仍有 ${pending.length} 项待重验/未检：${pending.map((p) => p.label).join('、')}`)
    const changes = this.repo.listContentChanges(task.docId).filter((c) =>
      claim && c.changedAt >= (task.createdAt || 0))
    changes.forEach((c) => reasons.push(`正文/依赖变化：${c.summary || c.changeKind}`))
    return { task, items, reasons, ownerName: owner?.name || null }
  }
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}
