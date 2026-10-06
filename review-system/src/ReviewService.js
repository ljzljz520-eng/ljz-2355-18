import { createHash } from 'node:crypto'
import {
  addDatePart, dueFromNow, dueFromPublish, isSameZonedDay,
  todayIn, zonedDatePart, zonedToUtc
} from './time.js'

/**
 * 产品文档复审管理 —— 核心领域服务。
 *
 * 设计约束（对应需求条目）：
 *  - 任务按"发布版"生成；固定周期扫描与依赖变更触发合并为同一打开任务，重复触发幂等。
 *  - 负责人离职 / 小组调整只转派"待办"，不可变的签收记录保留原签收者。
 *  - 复审到期仅给出"信息需核实"提示，绝不撤回 / 下线历史可读内容（没有 unpublish 操作）。
 *  - 审阅项覆盖图必须满足声明范围；检查一处示例 ≠ 整篇复审通过。
 *  - 正文关键块变化 / 依赖变化使关联检查项回到待重验。
 *  - 公开日期只在完整范围签收通过时写入，反映真实完成范围；可被后续失效并再次前移。
 *  - 维护者可见结构化超期原因，而不只是一个黄色标签。
 */

const OPEN = new Set(['open', 'in_progress'])

export class CoverageError extends Error {
  constructor(uncoveredTargets, extraTargets) {
    super('审阅项覆盖图不满足声明范围')
    this.name = 'CoverageError'
    this.uncoveredTargets = uncoveredTargets
    this.extraTargets = extraTargets
  }
}

const sha = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex')

export class ReviewService {
  /**
   * @param {object} deps
   * @param {import('./repo-json.js').JsonRepo} deps.repo 仓储（JSON 或 PG 实现同一接口）
   * @param {string} deps.zone 站点 IANA 时区，如 Asia/Shanghai
   * @param {() => Date} [deps.clock] 可注入时钟，便于验收
   * @param {number} [deps.dependencyGraceDays] 依赖触发后的再验证宽限天数
   */
  constructor({ repo, zone, clock = () => new Date(), dependencyGraceDays = 7 }) {
    this.repo = repo
    this.zone = zone
    this.clock = clock
    this.grace = dependencyGraceDays
  }

  get now() { return this.clock() }

  // ---------- 人员与文档 ----------

  createUser({ id, name, group = null, active = true }) {
    const user = { id, name, group, active, createdAt: this.now.toISOString() }
    this.repo.put('users', id, user)
    return user
  }

  registerDoc({ id, path, title, ownerId, group = null }) {
    if (ownerId && !this.repo.get('users', ownerId)) throw new Error(`负责人不存在: ${ownerId}`)
    const owner = ownerId ? this.repo.get('users', ownerId) : null
    const doc = {
      id, path, title, ownerId, group: group ?? owner?.group ?? null,
      currentReleaseId: null, createdAt: this.now.toISOString()
    }
    this.repo.put('docs', id, doc)
    return doc
  }

  // ---------- 发布：按发布版生成维护任务 ----------

  /**
   * @param {object} p
   * @param {Array<{id:string,title:string,content:*,dependsOn?:string[]}>} p.blocks
   *   正文分块；dependsOn 声明本块引用/依赖的检查目标（示例、接口、截图等）
   * @param {Array<{id:string,label:string,kind?:string}>} p.declaredScope 声明的复审范围
   * @param {Array<{targetId:string,covers?:string[],label?:string}>} [p.checks]
   *   可选：自定义审阅项覆盖图；默认每个声明目标生成一项（覆盖其自身）。
   */
  publishRelease({ docId, version, blocks = [], declaredScope = [], intervalDays = 30, checks = null }) {
    const doc = this.#mustGet('docs', docId)
    const prev = doc.currentReleaseId ? this.repo.get('releases', doc.currentReleaseId) : null
    const at = this.now.toISOString()

    // 覆盖图必须满足声明范围（检查项 covers 的并集 ⊇ 声明目标；不允许悬空目标）
    const scope = declaredScope.map(t => ({ id: t.id, label: t.label, kind: t.kind || 'target' }))
    const declaredIds = new Set(scope.map(t => t.id))
    const itemSpecs = (checks ?? scope.map(t => ({ targetId: t.id, covers: [t.id] })))
      .map(c => ({ targetId: c.targetId, covers: c.covers ?? [c.targetId], label: c.label }))
    const covered = new Set(itemSpecs.flatMap(i => i.covers))
    const uncovered = [...declaredIds].filter(id => !covered.has(id))
    const extra = [...covered].filter(id => !declaredIds.has(id))
    if (uncovered.length || extra.length) throw new CoverageError(uncovered, extra)

    const normalizedBlocks = blocks.map(b => ({
      id: b.id, title: b.title || b.id,
      hash: sha(b.content ?? ''), dependsOn: [...new Set(b.dependsOn || [])]
    }))
    const prevBlockHashes = new Map((prev?.blocks ?? []).map(b => [b.id, b.hash]))
    // 仅"已存在正文块的内容 hash 变化"才算关键变化；首次发布的块没有旧结论可失效
    const changedBlocks = normalizedBlocks.filter(b =>
      prevBlockHashes.has(b.id) && prevBlockHashes.get(b.id) !== b.hash)
    // 正文关键变化 → 受影响的声明目标（依赖该块的检查项需重验）
    const affectedTargets = new Set(changedBlocks.flatMap(b => b.dependsOn.filter(declaredIds.has.bind(declaredIds))))

    const release = {
      id: `rel_${docId}_${version}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      docId, version, publishedAt: at,
      contentHash: sha(normalizedBlocks),
      blocks: normalizedBlocks,
      declaredScope: scope,
      intervalDays,
      publicDate: null,
      lastVerifiedAt: null, // 最近一次完整范围签收时刻（不会被依赖失效清空，用作周期锚点）
      supersedes: prev?.id ?? null
    }
    this.repo.put('releases', release.id, release)

    // 新版的检查项：受影响目标携带"待重验"标记及原因（正文关键变化）
    const items = itemSpecs.map(spec => {
      const target = scope.find(t => t.id === spec.targetId)
      const relatedChanged = changedBlocks
        .filter(b => b.dependsOn.includes(spec.targetId))
        .map(b => ({ id: b.id, title: b.title }))
      const item = {
        id: `chk_${release.id}_${spec.targetId}`.replace(/[^a-zA-Z0-9_]/g, '_'),
        releaseId: release.id,
        targetId: spec.targetId,
        label: spec.label || target?.label || spec.targetId,
        kind: target?.kind || 'target',
        covers: spec.covers,
        status: 'pending',
        revalidate: relatedChanged.length
          ? { reason: 'body-change', changedBlocks: relatedChanged, since: at }
          : null,
        evidence: [],
        checkedById: null,
        checkedAt: null
      }
      this.repo.put('checkItems', item.id, item)
      return item
    })

    // 上一版的打开任务随新版发布而被取代（历史任务保留，状态置为 superseded，不删除）
    for (const t of this.repo.list('tasks').filter(t => t.releaseId === (prev?.id ?? '') && OPEN.has(t.status))) {
      t.status = 'superseded'
      t.closedAt = at
      this.repo.put('tasks', t.id, t)
    }

    // 两类任务合并：发布即产生周期任务；正文关键变化只体现为相关项"待重验"，
    // 不额外追加 dependency 触发（dependency 触发专指外部依赖图变更）。
    const scheduleDue = dueFromPublish(this.zone, this.now, intervalDays)
    const triggers = [{ kind: 'schedule', at, cycleIndex: 1, detail: { intervalDays } }]
    const dueDate = scheduleDue
    const task = this.#makeTask({
      release, assigneeId: doc.ownerId,
      triggers, dueDate, cycleIndex: 1
    })

    doc.currentReleaseId = release.id
    this.repo.put('docs', docId, doc)
    return { release, items, task, changedBlocks: changedBlocks.map(b => ({ id: b.id, title: b.title })) }
  }

  // ---------- 固定周期扫描（与依赖触发可双向合并，重复执行幂等） ----------

  runCycleScan(at = this.now) {
    const created = []
    const atIso = at.toISOString()
    for (const doc of this.repo.list('docs')) {
      if (!doc.currentReleaseId) continue
      const release = this.repo.get('releases', doc.currentReleaseId)
      if (!release) continue

      let task = this.repo.list('tasks')
        .find(t => t.releaseId === release.id && OPEN.has(t.status))

      if (task) {
        // 已有打开任务（周期/依赖已合并）：进入新周期则追加 schedule 触发并推进 cycleIndex；
        // 同周期重复扫描幂等；锚点为最近一次完整签收（不会被依赖失效清空）
        const anchor = new Date(release.lastVerifiedAt ?? release.publishedAt)
        const anchorDay = zonedDatePart(this.zone, anchor)
        const elapsedDays = Math.max(0, Math.round(
          (Date.parse(zonedDatePart(this.zone, at)) - Date.parse(anchorDay)) / 86400_000))
        const currentCycle = Math.floor(elapsedDays / release.intervalDays) + 1
        if (task.triggers.some(tr => tr.kind === 'schedule' && tr.cycleIndex === currentCycle)) continue
        task.triggers.push({ kind: 'schedule', at: atIso, cycleIndex: currentCycle, detail: { intervalDays: release.intervalDays } })
        task.cycleIndex = currentCycle
        // 合并两类到期日：固定周期 vs 依赖宽限，取更早
        const cycleDue = dueFromPublish(this.zone, anchor, release.intervalDays * currentCycle)
        if (cycleDue < new Date(task.dueDate)) task.dueDate = cycleDue.toISOString()
        this.repo.put('tasks', task.id, task)
        created.push(task.id)
        continue
      }

      // 无打开任务：锚点 = 最近一次完整签收日（复审后重新计时），否则发布日
      const anchor = new Date(release.lastVerifiedAt ?? release.publishedAt)
      const anchorDay = zonedDatePart(this.zone, anchor)
      const scanDay = zonedDatePart(this.zone, at)
      const elapsedDays = Math.max(0, Math.round((Date.parse(scanDay) - Date.parse(anchorDay)) / 86400_000))
      // 补扫：长时间没扫描时，落到最早一个已到期且未处理的周期（维护者能看到超期）
      const cycleIndex = elapsedDays >= release.intervalDays
        ? Math.floor(elapsedDays / release.intervalDays)
        : 1
      const dueDate = dueFromPublish(this.zone, anchor, release.intervalDays * cycleIndex)
      task = this.#makeTask({ release, assigneeId: doc.ownerId, triggers: [], dueDate, cycleIndex })
      task.triggers.push({ kind: 'schedule', at: atIso, cycleIndex, detail: { intervalDays: release.intervalDays } })
      this.repo.put('tasks', task.id, task)
      created.push(task.id)
    }
    return { scannedAt: atIso, tasksTouched: created }
  }

  /**
   * 按依赖变更触发（外部依赖图：上游接口/素材变化，文档本身未发新版）。
   * 关联检查项回到"待重验"；依赖触发并入当前打开任务；无任务则新建。重复触发幂等。
   */
  triggerDependencyChange({ docId, targetIds, reason = 'upstream-change', changedRef = null, at = this.now }) {
    const doc = this.#mustGet('docs', docId)
    if (!doc.currentReleaseId) throw new Error('文档尚未发布')
    // 依赖触发使关联项回到待重验：若这些目标原本处在"完整已验证"状态，
    // 才清空当前公开日期（真实完成范围缩小）；周期到期不清公开日期。
    const release = this.repo.get('releases', doc.currentReleaseId)
    const valid = new Set(release.declaredScope.map(t => t.id))
    const targets = targetIds.filter(valid.has.bind(valid))
    if (!targets.length) return { merged: false, reason: 'no-matching-target' }
    const atIso = at.toISOString()

    // 幂等：同一 (release, reason, targets 集合, 站点时区日) 只触发一次
    const key = `${reason}|[...targets].sort().join(',')`
    const day = zonedDatePart(this.zone, at)
    let task = this.repo.list('tasks').find(t => t.releaseId === release.id && OPEN.has(t.status))
    const dup = task?.triggers.some(tr =>
      tr.kind === 'dependency' && tr.reason === reason && tr.day === day &&
      sameSet(tr.affectedTargets, targets))
    if (dup) return { merged: true, idempotent: true, taskId: task.id }

    // 关键变化 → 相关项待重验（清掉旧通过态）
    const resetItems = []
    let invalidatedVerified = false
    for (const item of this.repo.list('checkItems').filter(i => i.releaseId === release.id)) {
      if (item.covers.some(c => targets.includes(c))) {
        if (item.status === 'passed') invalidatedVerified = true
        item.status = 'pending'
        item.checkedById = null
        item.checkedAt = null
        item.revalidate = { reason, changedRef, since: atIso }
        this.repo.put('checkItems', item.id, item)
        resetItems.push(item.id)
      }
    }
    if (invalidatedVerified && release.publicDate) {
      // 只在"已验证结论被变化推翻"时清空当前公开日期；历史内容仍可读，
      // 上次真实完成范围保存在 lastPublicDate；纯周期到期不动 publicDate。
      release.lastPublicDate = release.publicDate
      release.publicDate = null
      this.repo.put('releases', release.id, release)
    }

    if (!task) {
      task = this.#makeTask({
        release, assigneeId: doc.ownerId, triggers: [],
        dueDate: dueFromNow(this.zone, at, this.grace), cycleIndex: 1
      })
    }
    task.triggers.push({
      kind: 'dependency', at: atIso, day, reason, changedRef,
      affectedTargets: targets, dedupeKey: key
    })
    const depDue = dueFromNow(this.zone, at, this.grace)
    if (depDue < new Date(task.dueDate)) task.dueDate = depDue.toISOString()
    this.repo.put('tasks', task.id, task)
    return { merged: true, taskId: task.id, resetItems }
  }

  // ---------- 检查与签收 ----------

  /**
   * 记录单个检查项结果。检查一处示例只影响该目标，不代表整篇通过。
   * 部分失败 / 部分通过不会产生签收；全部声明目标由通过项覆盖时才写公开日期。
   */
  recordCheck({ releaseId, targetId, status, byUserId, evidence = null, at = this.now }) {
    if (!['passed', 'failed', 'na'].includes(status)) throw new Error(`非法检查状态: ${status}`)
    const user = this.#mustGet('users', byUserId)
    // 一项检查只代表它覆盖的目标；不允许拿别的项"代替"签收
    const item = this.repo.list('checkItems')
      .find(i => i.releaseId === releaseId && i.covers.includes(targetId))
    if (!item) throw new Error(`检查项不存在或未覆盖目标: ${releaseId}/${targetId}`)

    const atIso = at.toISOString()
    const prev = { status: item.status, checkedById: item.checkedById, checkedAt: item.checkedAt }
    item.status = status === 'na' ? 'na' : status
    item.checkedById = user.id
    item.checkedAt = atIso
    const ev = { at: atIso, by: user.id, status, evidence, previous: prev }
    item.evidence.push(ev)
    this.repo.put('checkItems', item.id, item)
    this.repo.put('evidence', `ev_${item.id}_${item.evidence.length}`, {
      id: `ev_${item.id}_${item.evidence.length}`,
      kind: 'check', refId: item.id, ...ev
    })

    return this.#evaluateRelease(releaseId, at)
  }

  #evaluateRelease(releaseId, at) {
    const release = this.repo.get('releases', releaseId)
    const items = this.repo.list('checkItems').filter(i => i.releaseId === releaseId)
    const coveredByPassed = new Set(items.filter(i => i.status === 'passed').flatMap(i => i.covers))
    const declared = release.declaredScope.map(t => t.id)
    const failed = items.filter(i => i.status === 'failed')
    const pending = items.filter(i => i.status === 'pending')
    const complete = declared.every(id => coveredByPassed.has(id))

    let signedOff = false
    if (complete && !failed.length && !pending.length) {
      const atIso = at.toISOString()
      // 签收证据不可变；再次进入完整态（重验通过）产生新的签收与新的公开日期
      const already = this.repo.list('signoffs')
        .find(s => s.releaseId === releaseId && s.scopeFingerprint === fingerprint(items))
      if (!already) {
        const signoff = {
          id: `sign_${releaseId}_${this.repo.list('signoffs').length + 1}`,
          releaseId, docId: release.docId,
          signedById: items.find(i => i.status === 'passed')?.checkedById ?? null,
          signedAt: atIso,
          scope: declared, checksPassed: items.filter(i => i.status === 'passed').map(i => i.id),
          scopeFingerprint: fingerprint(items),
          publishedDate: release.publicDate
        }
        this.repo.put('signoffs', signoff.id, signoff)
        this.repo.put('evidence', signoff.id, {
          id: signoff.id, kind: 'signoff', refId: releaseId,
          at: atIso, by: signoff.signedById, scope: declared
        })
        release.publicDate = atIso
        release.lastVerifiedAt = atIso
        signedOff = true
      }
      this.repo.put('releases', releaseId, release)

      const task = this.repo.list('tasks').find(t => t.releaseId === releaseId && OPEN.has(t.status))
      if (task) {
        task.status = 'done'
        task.closedAt = atIso
        task.closedReason = 'verified'
        this.repo.put('tasks', task.id, task)
      }
    }
    return {
      complete, signedOff,
      coverage: {
        total: declared.length,
        passed: declared.filter(id => coveredByPassed.has(id)).length,
        failed: failed.map(i => ({ targetId: i.targetId, label: i.label, evidence: i.evidence.at(-1)?.evidence ?? null })),
        pending: pending.map(i => ({ targetId: i.targetId, label: i.label, revalidate: i.revalidate }))
      }
    }
  }

  // ---------- 责任交接：转派待办，不覆盖曾签收者 ----------

  /**
   * @param {object} p
   * @param {'user'|'group'} p.type 负责人离职 / 小组调整
   * @param {string} p.subjectId 离职用户 id，或被调整的小组名
   * @param {string} [p.toUserId] 继任负责人；为空 = 无继任（任务挂起为 unassigned）
   */
  handover({ type, subjectId, toUserId = null, reason = '', at = this.now }) {
    const atIso = at.toISOString()
    if (toUserId && !this.repo.get('users', toUserId)) throw new Error(`继任者不存在: ${toUserId}`)
    const docs = this.repo.list('docs')
    const tasks = this.repo.list('tasks')

    let affectedDocs
    if (type === 'user') {
      const leaver = this.#mustGet('users', subjectId)
      leaver.active = false
      leaver.leftAt = atIso
      this.repo.put('users', subjectId, leaver)
      affectedDocs = docs.filter(d => d.ownerId === subjectId)
    } else {
      // 小组调整只影响"当前负责人仍在职且属于该组"的文档；
      // 已因离职变为无主（ownerId=null）的文档不在此列，避免覆盖无继任状态
      affectedDocs = docs.filter(d => {
        if (d.group !== subjectId || !d.ownerId) return false
        const owner = this.repo.get('users', d.ownerId)
        return owner?.active && owner.group === subjectId
      })
    }

    const affectedTaskIds = []
    for (const doc of affectedDocs) {
      // 签收记录里的 signedById 保持为原签收者，绝不改写
      doc.ownerId = toUserId
      if (type === 'group' && toUserId) {
        const successor = this.repo.get('users', toUserId)
        doc.group = successor?.group ?? doc.group
      }
      this.repo.put('docs', doc.id, doc)

      for (const task of tasks.filter(t => t.docId === doc.id && OPEN.has(t.status))) {
        const previousAssignee = task.assigneeId
        task.assigneeId = toUserId // null 时任务成为无主待办
        task.triggers.push({
          kind: 'transfer', at: atIso, from: previousAssignee, to: toUserId,
          reason: reason || (type === 'user' ? 'owner-leave' : 'group-adjust')
        })
        if (!toUserId) task.status = 'unassigned'
        this.repo.put('tasks', task.id, task)
        affectedTaskIds.push(task.id)
      }
    }

    const record = {
      id: `handover_${this.repo.list('handovers').length + 1}`,
      at: atIso, type, subjectId, toUserId, reason,
      affectedDocIds: affectedDocs.map(d => d.id), affectedTaskIds
    }
    this.repo.put('handovers', record.id, record)
    return record
  }

  // ---------- 提醒任务（每日幂等，可重跑） ----------

  runReminders({ at = this.now, channel = 'default' } = {}) {
    const atIso = at.toISOString()
    const day = zonedDatePart(this.zone, at)
    const sent = []
    for (const task of this.repo.list('tasks').filter(t => t.status === 'unassigned' || OPEN.has(t.status))) {
      const due = new Date(task.dueDate)
      const endOfDay = zonedToUtc(this.zone, day, 23, 59, 59, 999)
      if (due > endOfDay) continue
      // 幂等键：任务 + 站点时区日历日 + 渠道；当天重跑不重复提醒
      const exists = this.repo.list('reminders').some(r => r.taskId === task.id && r.day === day && r.channel === channel)
      if (exists) { sent.push({ taskId: task.id, idempotent: true }); continue }
      const release = this.repo.get('releases', task.releaseId)
      const doc = this.repo.get('docs', task.docId)
      const reminder = {
        id: `rem_${this.repo.list('reminders').length + 1}`,
        taskId: task.id, day, channel, at: atIso,
        to: task.assigneeId || 'maintainer-backlog',
        unassigned: !task.assigneeId,
        overdueReasons: this.explainOverdue(task.id, at).reasons
      }
      this.repo.put('reminders', reminder.id, reminder)
      sent.push({ taskId: reminder.taskId, id: reminder.id })
    }
    return { day, sent }
  }

  // ---------- 状态与超期原因（维护者可见"为什么"） ----------

  statusOf(releaseId, now = this.now) {
    const release = this.repo.get('releases', releaseId)
    const items = this.repo.list('checkItems').filter(i => i.releaseId === releaseId)
    const passedTargets = new Set(items.filter(i => i.status === 'passed').flatMap(i => i.covers))
    const declared = release.declaredScope
    const failed = items.filter(i => i.status === 'failed')
    const pending = items.filter(i => i.status === 'pending')
    const revalidating = items.filter(i => i.status === 'pending' && i.revalidate)
    const complete = declared.every(t => passedTargets.has(t.id))

    const passedItems = items.filter(i => i.status === 'passed')
    let level = passedItems.length ? 'in-progress' : 'needs-review'
    if (complete && !failed.length && !pending.length) level = 'verified'
    else if (revalidating.length) level = 'needs-recheck'   // 信息需核实（内容仍可读）
    else if (failed.length) level = 'partial-failed'

    const task = this.repo.list('tasks').find(t => t.releaseId === releaseId && (OPEN.has(t.status) || t.status === 'unassigned'))
    let overdue = false
    if (task && new Date(task.dueDate) < now) {
      overdue = true
      // 超期标签分层：
      // 已验证但到期待核实(琥珀) > 部分失败/重验(橙) > 无继任(红) > 普通超期
      if (level === 'verified') level = 'due-for-review'   // 历史结论仍公开，仅提示"信息需核实"
      else if (task.status === 'unassigned' || !task.assigneeId) level = 'overdue-unassigned'
      else if (level !== 'partial-failed' && level !== 'needs-recheck') level = 'overdue'
    }
    return {
      level, overdue, complete,
      publicDate: release.publicDate, lastPublicDate: release.lastPublicDate ?? null,
      coverage: {
        total: declared.length,
        passed: declared.filter(t => passedTargets.has(t.id)).length,
        failed: failed.map(i => ({ targetId: i.targetId, label: i.label, lastEvidence: i.evidence.at(-1)?.evidence ?? null })),
        pending: pending.map(i => ({ targetId: i.targetId, label: i.label, revalidate: i.revalidate }))
      },
      task: task ? {
        id: task.id, status: task.status, dueDate: task.dueDate,
        assigneeId: task.assigneeId, triggers: task.triggers.map(t => ({ ...t }))
      } : null
    }
  }

  /** 结构化超期原因：维护者看到的是"为什么超期"，而不只是黄色标签 */
  explainOverdue(taskId, now = this.now) {
    const task = this.#mustGet('tasks', taskId)
    const release = this.repo.get('releases', task.releaseId)
    const doc = this.repo.get('docs', task.docId)
    const reasons = []
    const owner = doc.ownerId ? this.repo.get('users', doc.ownerId) : null

    for (const tr of task.triggers) {
      if (tr.kind === 'schedule') {
        reasons.push({
          type: 'cycle',
          text: `固定周期：v${release.version} 发布于 ${zonedDatePart(this.zone, new Date(release.publishedAt))}，` +
                `复审周期 ${release.intervalDays} 天，应于 ${zonedDatePart(this.zone, new Date(task.dueDate))} 前完成（第 ${tr.cycleIndex} 周期）`
        })
      } else if (tr.kind === 'dependency') {
        const labels = (tr.affectedTargets || []).map(id =>
          release.declaredScope.find(s => s.id === id)?.label ?? id).join('、')
        reasons.push({
          type: 'dependency',
          text: `依赖变更${tr.changedRef ? `（${tr.changedRef}）` : ''}使 ${labels} 需重新核对，宽限 ${this.grace} 天至 ` +
                `${zonedDatePart(this.zone, new Date(task.dueDate))}`
        })
      } else if (tr.kind === 'transfer') {
        const from = tr.from ? this.repo.get('users', tr.from)?.name ?? tr.from : '原负责人'
        reasons.push({
          type: 'handover',
          text: `责任交接：${from} ${tr.reason === 'owner-leave' ? '离职' : '因小组调整'}，` +
                `${tr.to ? `已转派给 ${this.repo.get('users', tr.to)?.name ?? tr.to}` : '目前无继任负责人，待办挂起'}`
        })
      }
    }

    const items = this.repo.list('checkItems').filter(i => i.releaseId === release.id)
    for (const f of items.filter(i => i.status === 'failed')) {
      reasons.push({
        type: 'check-failed',
        text: `检查未通过：${f.label}${f.evidence.at(-1)?.evidence ? `（${f.evidence.at(-1).evidence}）` : ''}`
      })
    }
    for (const p of items.filter(i => i.status === 'pending' && i.revalidate)) {
      const blocks = p.revalidate.changedBlocks?.map(b => b.title).join('、')
      reasons.push({
        type: 'revalidate',
        text: `待重验：${p.label} 因正文「${blocks ?? p.revalidate.changedRef ?? '依赖内容'}」发生关键变化，旧结论不再沿用`
      })
    }
    if (!task.assigneeId || task.status === 'unassigned') {
      reasons.push({ type: 'no-owner', text: '当前没有可处理该任务的负责人，需先指定继任者' })
    }

    const overdueDays = new Date(task.dueDate) < now
      ? Math.max(1, Math.round((now - new Date(task.dueDate)) / 86400_000)) : 0
    return {
      taskId,
      docTitle: doc.title,
      version: release.version,
      overdue: overdueDays > 0,
      overdueDays,
      reasons,
      owner: owner ? { id: owner.id, name: owner.name } : null
    }
  }

  // ---------- 内部工具 ----------

  #makeTask({ release, assigneeId, triggers, dueDate, cycleIndex }) {
    const task = {
      id: `task_${release.id}_${this.repo.list('tasks').length + 1}`,
      releaseId: release.id, docId: release.docId,
      status: assigneeId ? 'open' : 'unassigned',
      assigneeId: assigneeId ?? null,
      createdAt: this.now.toISOString(),
      dueDate: new Date(dueDate).toISOString(),
      cycleIndex, triggers
    }
    this.repo.put('tasks', task.id, task)
    return task
  }

  #mustGet(coll, id) {
    const v = this.repo.get(coll, id)
    if (!v) throw new Error(`${coll} 中不存在: ${id}`)
    return v
  }
}

function sameSet(a = [], b = []) {
  const x = new Set(a), y = new Set(b)
  return x.size === y.size && [...x].every(v => y.has(v))
}

function fingerprint(items) {
  return sha(items
    .filter(i => i.status === 'passed')
    .map(i => `${i.targetId}:${i.covers.join('|')}:${i.checkedAt}`)
    .sort())
}
