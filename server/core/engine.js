// 文档复审引擎：纯领域逻辑，不依赖 PG。
//
// 需求映射：
// - 后台按发布版生成维护任务：publishRelease + scanFixed（固定周期扫描）
// - 依赖变更触发：triggerDependencyChange；两类任务双向合并
// - 幂等：fixed/change/reminder 三类幂等键，重复触发安全重放
// - 负责人离职 / 小组调整：handover / groupReassign 只转派待办，不覆盖已签收者
// - 复审到期：只产生提示与“信息需核实”，不撤历史可读内容（签收 append-only）
// - 一处示例 != 整篇：items 逐项检查；图必须满足 frontmatter 声明范围
// - 正文关键变化：相关项回到待重验；签收时若页面已更新则拒绝签收

import { ReviewError, Codes } from './errors.js'
import { buildItems, coverageCheck } from './items.js'
import { fixedScanKey, changeTriggerKey, reminderKey } from './keys.js'
import {
  DEFAULT_ZONE, addZonedDays, startOfToday, isOverdue, daysUntil,
  formatZoned, zonedDayStart, zonedParts
} from './time.js'

const CHANGE_SLA_DAYS = 7
const REMIND_AHEAD_DAYS = 3

export class ReviewEngine {
  /**
   * @param {object} opts
   * @param {import('../store/memory.js').MemoryRepo} opts.repo
   * @param {string} [opts.zone] 站点时区
   * @param {() => number} [opts.clock] 可注入时钟（测试时间旅行）
   */
  constructor({ repo, zone = DEFAULT_ZONE, clock = () => Date.now() } = {}) {
    this.repo = repo
    this.zone = zone
    this.clock = clock
  }

  get now() { return new Date(this.clock()) }

  // ---------------------------------------------------------------- 基础数据
  async addUser({ id, name, active = true }) {
    return this.repo.put('users', { id, name, active })
  }

  async addGroup({ id, name, memberIds = [] }) {
    await this.repo.put('groups', { id, name })
    for (const userId of memberIds) {
      await this.repo.put('groupMembers', { id: `${id}:${userId}`, groupId: id, userId })
    }
  }

  async addDoc({
    id, route, title, ownerId, groupId = null,
    cycleDays = 90, declaredScope = ['body', 'examples', 'figures']
  }) {
    if (ownerId) {
      const owner = await this.repo.get('users', ownerId)
      if (!owner) throw new ReviewError(Codes.NO_OWNER, `owner not found: ${ownerId}`)
    }
    return this.repo.put('docs', {
      id, route, title, ownerId, groupId, cycleDays,
      declaredScope, createdAt: this.clock()
    })
  }

  async publishRelease({ id, name, at = this.clock() }) {
    return this.repo.put('releases', { id, name, publishedAt: at })
  }

  async _resolveOwner(doc) {
    if (!doc.ownerId) return null
    const u = await this.repo.get('users', doc.ownerId)
    if (!u || !u.active) return null
    return u
  }

  // ------------------------------------------------- 负责人离职 / 小组调整
  /**
   * 转派（或离职无继任）。
   * - 只更新 doc.ownerId，并为当前 open 任务写交接记录；
   * - 绝不修改 signoffs（曾签收者永远保留）；
   * - toUserId = null 表示“暂无继任负责人”，任务保持打开并被标记 owner_missing。
   */
  async handover(docId, { toUserId = null, by, reason = '' }) {
    const doc = await this.repo.get('docs', docId)
    if (!doc) throw new ReviewError(Codes.DOC_NOT_FOUND, docId)
    if (toUserId) {
      const to = await this.repo.get('users', toUserId)
      if (!to || !to.active) throw new ReviewError(Codes.NO_OWNER, `successor invalid: ${toUserId}`)
    }
    const openTasks = await this.repo.list('tasks', (t) => t.docId === docId && t.status === 'open')
    const record = await this.repo.appendHandover({
      docId,
      fromOwnerId: doc.ownerId,
      toOwnerId: toUserId,
      openTaskIds: openTasks.map((t) => t.id),
      reason, by
    })
    await this.repo.update('docs', docId, { ownerId: toUserId })
    await this.repo.appendAudit({ action: 'handover', docId, fromOwnerId: doc.ownerId, toOwnerId: toUserId, by, reason })
    return record
  }

  /**
   * 小组调整：把整组文档的待办批量转派给新负责人（逐条留痕，可区分每篇文档）。
   */
  async groupReassign(groupId, { toUserId, by, reason = '' }) {
    const docs = await this.repo.list('docs', (d) => d.groupId === groupId)
    const out = []
    for (const doc of docs) {
      if (doc.ownerId === toUserId) continue
      out.push(await this.handover(doc.id, { toUserId, by, reason }))
    }
    return out
  }

  // ------------------------------------------------------------ 任务生成

  /**
   * 同一文档在新发布版产生任务时，旧发布版仍 open 的任务标记为 superseded：
   * 不删除、不改历史签收（仍可读），只是不再作为待办/状态来源。
   */
  async _supersedeOtherOpen(tx, docId, keepTaskId) {
    const others = await tx.list('tasks',
      (t) => t.docId === docId && t.status === 'open' && t.id !== keepTaskId)
    for (const t of others) {
      await tx.update('tasks', t.id, {
        status: 'superseded', supersededBy: keepTaskId, supersededAt: this.clock()
      })
    }
    return others.length
  }

  /**
   * 固定周期扫描（按发布版）。
   * @param manifests Record<docId, {body:[{path,hash}], examples:[...], figures:[...], tables:[...], configs:[...]}>
   * 对每篇文档：同 release 已有 open 任务则合并（幂等），否则按 cycleDays 生成。
   */
  async scanFixed(releaseId, manifests = {}) {
    const release = await this.repo.get('releases', releaseId)
    if (!release) throw new ReviewError(Codes.INVALID_STATE, `release not found: ${releaseId}`)

    const docs = await this.repo.list('docs')
    const created = []
    const merged = []
    const skipped = []

    for (const doc of docs) {
      const res = await this.repo.tx(async (tx) => {
        return tx.acquireIdempotency(fixedScanKey(releaseId, doc.id), async () => {
          const today = startOfToday(this.now, this.zone)
          const dueDate = addZonedDays(today, doc.cycleDays, this.zone).getTime()
          const trigger = await tx.put('triggers', {
            releaseId, docId: doc.id, type: 'fixed',
            reason: 'fixed-cycle-scan', createdAt: this.clock()
          })
          const existing = await this._openTaskForTx(tx, doc.id, releaseId)
          let task
          if (existing) {
            task = await this._mergeTriggerTx(tx, existing, trigger.id, 'fixed-cycle-scan', { dueDate })
            await this._ensureItems(tx, { doc, task, manifest: manifests[doc.id] || {} })
            merged.push(task)
          } else {
            task = await tx.put('tasks', {
              docId: doc.id, releaseId, status: 'open', dueDate,
              createdAt: this.clock(),
              triggerIds: [trigger.id], reasons: ['fixed-cycle-scan'],
              reminderCount: 0, latestReminderAt: null, completedAt: null
            })
            await this._supersedeOtherOpen(tx, doc.id, task.id)
            await this._ensureItems(tx, { doc, task, manifest: manifests[doc.id] || {} })
            created.push(task)
          }
          return { id: task.id }
        })
      })
      if (res.hit) skipped.push({ docId: doc.id, taskId: res.refId })
    }
    return { created, merged, skipped }
  }

  /**
   * 为任务生成/刷新审阅项快照。每个证据单元（正文、每个示例、每张图、每张表）独立一项。
   * 已有 item 保持其检查状态（固定扫描重跑不覆盖检查结果；正文关键变化走 change 触发）。
   */
  async _ensureItems(tx, { doc, task, manifest }) {
    const items = buildItems(manifest)
    const out = []
    for (const spec of items) {
      const existing = await tx.find('items', (i) => i.taskId === task.id && i.itemKey === spec.itemKey)
      if (existing) {
        out.push(existing)
        continue
      }
      // item 快照保存“本次扫描发布时 manifest 声明的 hash”。
      // contentVersions 只记录扫描之后发生的变化，签收时与该快照比对即可识别“页面更新”。
      const row = await tx.put('items', {
        taskId: task.id,
        itemKey: spec.itemKey,
        kind: spec.kind,
        path: spec.path,
        contentHash: spec.contentHash,
        declared: spec.declared,
        status: 'pending',
        checkedAt: null,
        checkedBy: null
      })
      out.push(row)
    }
    return out
  }

  /**
   * 依赖变更触发（按发布版）。
   * @param changes Array<{docId, kind:'body'|'example'|'figure'|..., path, hash}>
   * 与固定任务双向合并；仅受影响的相关项回到 pending，其余项保留已检查结果与历史签收。
   */
  async triggerDependencyChange(releaseId, changes) {
    const release = await this.repo.get('releases', releaseId)
    if (!release) throw new ReviewError(Codes.INVALID_STATE, `release not found: ${releaseId}`)

    const created = []
    const merged = []
    const reverified = []
    const skipped = []

    for (const c of changes) {
      const doc = await this.repo.get('docs', c.docId)
      if (!doc) throw new ReviewError(Codes.DOC_NOT_FOUND, c.docId)
      // 幂等键包含 hash：同一次变更（含重试）只处理一次；内容再变（新 hash）会生成新触发。
      const key = changeTriggerKey(releaseId, c.docId, c.path, `${c.kind}:${c.hash}`)

      const res = await this.repo.tx(async (tx) => {
        const versions = (await tx.list('contentVersions',
          (v) => v.docId === c.docId && v.kind === c.kind && v.path === c.path))
          .sort((a, b) => a.at - b.at)
        const prevVersion = versions[versions.length - 1]
        if (prevVersion && prevVersion.hash === c.hash) {
          return { hit: true, refId: prevVersion.id, duplicate: true }
        }
        return tx.acquireIdempotency(key, async () => {
          await tx.put('contentVersions', {
            docId: c.docId, kind: c.kind, path: c.path, hash: c.hash,
            at: this.clock(), releaseId
          })
          const trigger = await tx.put('triggers', {
            releaseId, docId: c.docId, type: 'change',
            reason: `dep:${c.kind}:${c.path}`,
            causedBy: { kind: c.kind, path: c.path, hash: c.hash },
            createdAt: this.clock()
          })
          const today = startOfToday(this.now, this.zone)
          const dueDate = addZonedDays(today, CHANGE_SLA_DAYS, this.zone).getTime()
          let task = await this._openTaskForTx(tx, c.docId, releaseId)
          let bucket
          if (task) {
            task = await this._mergeTriggerTx(tx, task, trigger.id,
              `dep:${c.kind}:${c.path}`, { dueDate })
            bucket = merged
          } else {
            task = await tx.put('tasks', {
              docId: c.docId, releaseId, status: 'open', dueDate,
              createdAt: this.clock(),
              triggerIds: [trigger.id], reasons: [`dep:${c.kind}:${c.path}`],
              reminderCount: 0, latestReminderAt: null, completedAt: null
            })
            await this._supersedeOtherOpen(tx, c.docId, task.id)
            bucket = created
          }
          // 相关项回到待重验；若任务还没有该项则补一项。
          // 注意：这里故意不更新 contentHash —— hash 代表“已按该版本检查过”，
          // 只有 reviewer 重新检查时才刷新，签收据此识别“检查后页面又更新”。
          const itemKey = `${c.kind}:${c.path}`
          const item = await tx.find('items', (i) => i.taskId === task.id && i.itemKey === itemKey)
          if (item) {
            await tx.update('items', item.id, {
              status: 'pending', checkedAt: null, checkedBy: null
            })
          } else {
            await tx.put('items', {
              taskId: task.id, itemKey, kind: c.kind, path: c.path,
              contentHash: c.hash, declared: c.kind !== 'body',
              status: 'pending', checkedAt: null, checkedBy: null
            })
          }
          reverified.push({ taskId: task.id, itemKey })
          bucket.push(task)
          return { id: trigger.id }
        })
      })
      if (res.hit) skipped.push({ change: c, refId: res.refId })
    }
    return { created, merged, reverified, skipped }
  }

  async _openTaskForTx(tx, docId, releaseId) {
    return tx.find('tasks', (t) => t.docId === docId && t.releaseId === releaseId && t.status === 'open')
  }
  async _mergeTriggerTx(tx, task, triggerId, reason, { dueDate }) {
    const triggerIds = new Set(task.triggerIds)
    triggerIds.add(triggerId)
    const reasons = reason && !task.reasons.includes(reason) ? [...task.reasons, reason] : task.reasons
    return tx.update('tasks', task.id, {
      triggerIds: [...triggerIds],
      reasons,
      dueDate: dueDate < task.dueDate ? dueDate : task.dueDate
    })
  }

  // ---------------------------------------------------------------- 检查
  /**
   * 记录单项检查结果（允许部分失败）。
   * @param observedHash 复核时页面上实际看到的内容 hash（可选）。
   *   - 提供且与最新版本一致：正常记录，并把 item 快照刷新到该版本；
   *   - 提供但与最新版本不一致：说明打开页面后内容又发布了，拒绝并要求重验；
   *   - 不提供：若 item 已落后最新版本则拒绝（防止对着旧页面打勾）。
   * @param evidence [{kind:'screenshot'|'note'|'link', ref, sha256}]
   */
  async recordCheck(taskId, itemKey, { result, by, note = '', evidence = [], observedHash = null }) {
    if (!['passed', 'failed'].includes(result)) {
      throw new ReviewError(Codes.INVALID_STATE, `bad result: ${result}`)
    }
    const task = await this.repo.get('tasks', taskId)
    if (!task) throw new ReviewError(Codes.TASK_NOT_FOUND, taskId)
    if (task.status !== 'open') throw new ReviewError(Codes.INVALID_STATE, `task ${taskId} not open`)

    const item = await this.repo.find('items', (i) => i.taskId === taskId && i.itemKey === itemKey)
    if (!item) throw new ReviewError(Codes.ITEM_NOT_FOUND, itemKey)

    const versions = (await this.repo.list('contentVersions',
      (v) => v.docId === task.docId && v.kind === item.kind && v.path === item.path))
      .sort((a, b) => a.at - b.at)
    const latest = versions[versions.length - 1]
    const latestHash = latest ? latest.hash : item.contentHash

    // 复核必须针对最新内容；否则保持 pending，要求重验
    const observed = observedHash || (latestHash === item.contentHash ? latestHash : null)
    if (!observed || observed !== latestHash) {
      throw new ReviewError(Codes.CONTENT_CHANGED,
        `${itemKey} content changed; re-open the page and re-verify`,
        { current: latestHash, observed: observedHash, itemSnapshot: item.contentHash })
    }

    const check = await this.repo.put('checks', {
      taskId, itemKey, result, by, note,
      contentHashAtCheck: latestHash,
      at: this.clock()
    })
    for (const e of evidence) {
      await this.repo.appendEvidence({ ...e, checkId: check.id, taskId, by, at: this.clock() })
    }
    await this.repo.update('items', item.id, {
      status: result, checkedAt: this.clock(), checkedBy: by, contentHash: latestHash
    })
    return check
  }

  /**
   * 签收。规则：
   * 1) 声明范围（frontmatter declaredScope）内的项必须全部 passed —— 图必须满足声明范围；
   * 2) 不得签收范围外的项；
   * 3) 有 failed 项（部分检查失败）则拒绝签收；
   * 4) 签收瞬间页面内容相对检查快照发生关键变化 -> 拒绝，相关项重置为待重验；
   * 签收记录 append-only，日后转派/离职不会改变签收人。
   */
  async signoff(taskId, { by, note = '', evidence = [] }) {
    const task = await this.repo.get('tasks', taskId)
    if (!task) throw new ReviewError(Codes.TASK_NOT_FOUND, taskId)
    if (task.status !== 'open') throw new ReviewError(Codes.INVALID_STATE, `task ${taskId} not open`)

    const doc = await this.repo.get('docs', task.docId)
    const items = await this.repo.list('items', (i) => i.taskId === taskId)

    // 4) 签收时页面更新：任何在范围内的项 hash 落后于最新内容版本 -> 重置 + 拒绝
    const staleKeys = []
    for (const it of items) {
      const vList = (await this.repo.list('contentVersions',
        (v) => v.docId === task.docId && v.kind === it.kind && v.path === it.path))
        .sort((a, b) => a.at - b.at)
      const latest = vList[vList.length - 1]
      if (latest && latest.hash !== it.contentHash) {
        staleKeys.push(it.itemKey)
        await this.repo.update('items', it.id, {
          status: 'pending', contentHash: latest.hash, checkedAt: null, checkedBy: null
        })
      }
    }
    // 校验顺序：部分失败 -> 签收时页面更新（会把相关项重置为待重验）-> 声明范围覆盖。
    // 这样页面更新优先报 CONTENT_CHANGED，而不是被重置后的覆盖不足误报。
    const passedItemsNow = items.filter((i) => i.status === 'passed')
    const failedItems = items.filter((i) => i.status === 'failed')
    if (failedItems.length) {
      throw new ReviewError(Codes.ITEMS_FAILED,
        `${failedItems.length} item(s) failed`, { failed: failedItems.map((i) => i.itemKey) })
    }

    if (staleKeys.length) {
      throw new ReviewError(Codes.CONTENT_CHANGED,
        'page updated after checks; items require re-verification', { staleKeys })
    }

    const coverage = coverageCheck(items, passedItemsNow.map((i) => i.itemKey), doc.declaredScope)
    if (!coverage.ok) {
      throw new ReviewError(Codes.COVERAGE_INCOMPLETE,
        'declared review scope is not fully covered', coverage)
    }

    const passedItems = items.filter((i) => i.status === 'passed')
    const record = await this.repo.appendSignoff({
      taskId, docId: task.docId, releaseId: task.releaseId,
      by, note,
      scope: passedItems.map((i) => ({ itemKey: i.itemKey, kind: i.kind, path: i.path, hash: i.contentHash })),
      scopeKinds: [...new Set(passedItems.map((i) => i.kind))],
      at: this.clock()
    })
    for (const e of evidence) {
      await this.repo.appendEvidence({ ...e, signoffId: record.id, taskId, by, at: this.clock() })
    }
    await this.repo.update('tasks', taskId, {
      status: 'signed',
      completedAt: this.clock(),
      signedScopeCount: passedItems.length
    })
    await this.repo.appendAudit({ action: 'signoff', taskId, docId: task.docId, by, scope: record.scopeKinds })
    return record
  }

  // ---------------------------------------------------------------- 提醒
  /**
   * 提醒扫描。可安全重跑：
   * - 同一任务同一站点本地日窗口只生成一条 reminder（幂等键）；
   * - 重跑命中时累加 runCount，不产生重复通知；
   * - 维护者能看到“为何超期”（reasons），而不只是黄色标签。
   */
  async runReminders() {
    const tasks = await this.repo.list('tasks', (t) => t.status === 'open')
    const created = []
    const rerun = []
    let overdueCount = 0

    const now = this.now
    const p = zonedParts(now, this.zone)
    const winStart = zonedDayStart(p.year, p.month, p.day, this.zone).getTime()
    const winEnd = winStart + 86399999

    for (const task of tasks) {
      const dleft = daysUntil(new Date(task.dueDate), now, this.zone)
      if (dleft === null || dleft > REMIND_AHEAD_DAYS) continue
      const overdue = isOverdue(new Date(task.dueDate), now, this.zone)
      if (overdue) overdueCount += 1

      const doc = await this.repo.get('docs', task.docId)
      const items = await this.repo.list('items', (i) => i.taskId === task.id)
      const reasons = await this._overdueReasons({ doc, task, items, overdue, dleft })

      const res = await this.repo.tx((tx) =>
        tx.acquireIdempotency(reminderKey(task.id, winStart, winEnd), async () => {
          const reminder = await tx.appendReminder({
            taskId: task.id, windowStart: winStart, windowEnd: winEnd,
            overdue, daysLeft: dleft, reasons, runCount: 1, at: this.clock()
          })
          await tx.update('tasks', task.id, { latestReminderAt: this.clock(), reminderCount: (task.reminderCount || 0) + 1 })
          return { id: reminder.id }
        }))

      if (res.hit) {
        const existing = await this.repo.find('reminders',
          (r) => r.taskId === task.id && r.windowStart === winStart)
        const updated = await this.repo.update('reminders', existing.id, {
          runCount: (existing.runCount || 1) + 1,
          lastRerunAt: this.clock(),
          reasons // 原因以最新一次计算为准
        })
        rerun.push(updated)
      } else {
        created.push(await this.repo.get('reminders', res.refId))
      }
    }
    return { windowStart: winStart, windowEnd: winEnd, created, rerun, overdueCount }
  }

  /**
   * 超期/临期原因（面向维护者）。
   * codes 只放“为什么没完成”的结构性原因；时间状态（overdue/due_soon）由
   * status / daysLeft 单独表达，避免把“黄色标签”本身当成原因。
   */
  async _overdueReasons({ doc, task, items, overdue, dleft }) {
    const reasons = []
    const owner = await this._resolveOwner(doc)
    if (!owner) reasons.push('owner_missing') // 无继任负责人
    const failed = items.filter((i) => i.status === 'failed')
    const pending = items.filter((i) => i.status === 'pending')
    if (failed.length) reasons.push('failed_items')
    if (task.reasons?.some((r) => r.startsWith('dep:'))) reasons.push('content_changed_pending')
    if (pending.length && !failed.length) reasons.push('pending_items')
    const coverage = coverageCheck(
      items, items.filter((i) => i.status === 'passed').map((i) => i.itemKey), doc.declaredScope)
    if (!coverage.ok && pending.length === 0 && failed.length === 0) reasons.push('coverage_gap')
    if (reasons.length === 0) reasons.push(overdue ? 'overdue_without_progress' : 'awaiting_review')
    return {
      codes: [...new Set(reasons)],
      detail: {
        failedCount: failed.length,
        pendingCount: pending.length,
        totalCount: items.length,
        daysLeft: dleft,
        missing: coverage.missing,
        triggers: task.reasons || []
      }
    }
  }

  // ------------------------------------------------------------ 公开清单
  /**
   * 构建站点消费的公开清单。
   * - publicDate / verifiedScope 永远来自最近一次真实签收（反映真实完成范围）；
   * - 到期只改变提示状态，历史签收与可读内容保留；
   * - stale 表示生成时刻落后于最新内容变更，前端提示“信息需核实”。
   */
  async buildManifest({ generatedAt = this.clock(), maxAgeMs = null } = {}) {
    const docs = await this.repo.list('docs')
    const releases = await this.repo.list('releases')
    const releaseName = new Map(releases.map((r) => [r.id, r.name]))
    const out = []

    for (const doc of docs) {
      const owner = await this._resolveOwner(doc)
      const signoffs = (await this.repo.list('signoffs', (s) => s.docId === doc.id))
        .sort((a, b) => a.at - b.at)
      const latestSignoff = signoffs[signoffs.length - 1] || null
      const openTask = await this.repo.find('tasks', (t) => t.docId === doc.id && t.status === 'open')
      const items = openTask ? await this.repo.list('items', (i) => i.taskId === openTask.id) : []

      let status = 'verified'
      let reasons = null
      let daysLeft = null
      let dueDate = null
      if (openTask) {
        daysLeft = daysUntil(new Date(openTask.dueDate), this.now, this.zone)
        dueDate = openTask.dueDate
        const overdue = isOverdue(new Date(openTask.dueDate), this.now, this.zone)
        reasons = await this._overdueReasons({ doc, task: openTask, items, overdue, dleft: daysLeft })
        // 状态优先级：无负责人 > 已超期 > 部分失败 > 临期 > 复审中。
        // “为什么超期”全部保留在 reasons.codes/detail 中（不只是一个黄色标签）。
        if (!owner) status = 'owner_missing'
        else if (overdue) status = 'overdue'
        else if (items.some((i) => i.status === 'failed')) status = 'partial_failed'
        else if (daysLeft <= 3) status = 'due_soon'
        else status = 'in_review'
      }

      // stale：清单生成后又有内容变更，或清单年龄超过 maxAgeMs -> 前端提示“信息需核实”。
      // 到期不影响内容可读性，二者相互独立。
      const latestChangeAt = (await this.repo.list('contentVersions', (v) => v.docId === doc.id))
        .reduce((m, v) => Math.max(m, v.at), 0)
      const tooOld = maxAgeMs != null && generatedAt + maxAgeMs < this.clock()
      const stale = latestChangeAt > generatedAt || tooOld

      const scopeLabelMap = { body: 'body', example: 'examples', figure: 'figures', table: 'tables', config: 'configs' }
      out.push({
        docId: doc.id,
        route: doc.route,
        title: doc.title,
        declaredScope: doc.declaredScope,
        cycleDays: doc.cycleDays,
        owner: owner ? { id: owner.id, name: owner.name } : null,
        status,
        reasons,
        dueDate,
        dueDateText: dueDate ? formatZoned(new Date(dueDate), this.zone) : null,
        daysLeft,
        stale,
        items: {
          total: items.length,
          passed: items.filter((i) => i.status === 'passed').length,
          failed: items.filter((i) => i.status === 'failed').length,
          pending: items.filter((i) => i.status === 'pending').length
        },
        // 公开日期 = 最近一次真实签收完成时间；scope 如实反映完成范围
        publicDate: latestSignoff ? latestSignoff.at : null,
        publicDateText: latestSignoff ? formatZoned(new Date(latestSignoff.at), this.zone, true) : null,
        lastRelease: latestSignoff ? releaseName.get(latestSignoff.releaseId) || latestSignoff.releaseId : null,
        verifiedScope: latestSignoff
          ? [...new Set(latestSignoff.scopeKinds.map((k) => scopeLabelMap[k] || k))]
          : [],
        signoffHistory: signoffs.slice(-5).reverse().map((s) => ({
          by: s.by,
          at: s.at,
          atText: formatZoned(new Date(s.at), this.zone, true),
          release: releaseName.get(s.releaseId) || s.releaseId,
          scopeCount: s.scope?.length || 0,
          scopeKinds: s.scopeKinds
        }))
      })
    }

    return {
      generatedAt,
      generatedAtText: formatZoned(new Date(generatedAt), this.zone, true),
      zone: this.zone,
      docs: out
    }
  }
}

export { CHANGE_SLA_DAYS, REMIND_AHEAD_DAYS }
