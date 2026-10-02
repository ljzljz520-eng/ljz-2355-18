// ============================================================================
// 文档复审引擎
// 核心规则（与需求逐条对应）：
//  1. 后台按发布版为每页生成维护任务（release 任务，幂等）。
//  2. 固定周期扫描(periodic) 与 依赖变更触发(dependency) 两类任务会合并，
//     重复触发用 (page_id, idem_key) UNIQUE 保证幂等。
//  3. 负责人离职/小组调整：转派待办任务并记流水；历史签收者永不被覆盖。
//  4. 复审到期只把页面标记为 needs_verification（信息需核实），历史内容仍可读。
//  5. 抽查一处不等于整篇复审：签收必须覆盖声明范围且每项最新版本有通过结论。
//  6. 正文关键变化：相关审阅项升版本 → 旧结论作废 → 待重验，旧签收降级为历史。
//  7. 部分检查失败 → partial 签收：公开日期只反映真实完成的范围。
// ============================================================================
import { createStore, uuid, freezeAppendOnly } from './store.js'
import { coverageGaps, itemsTouched, matchNode } from './scope.js'
import { periodBucket, zonedMidnight, toDate, diffDays } from './time.js'

export class ReviewError extends Error {}

export function createEngine(now = () => Date.now()) {
  const store = createStore()
  freezeAppendOnly(store)
  const clock = () => toDate(now())

  // ---------------------------------------------------------------- members
  function addMember({ id, name, active = true }) {
    if (store.members.has(id)) throw new ReviewError(`member exists: ${id}`)
    store.members.set(id, { id, displayName: name, active, leftAt: null })
    return store.members.get(id)
  }

  function deactivateMember(memberId, at = clock()) {
    const m = store.members.get(memberId)
    if (!m) throw new ReviewError(`unknown member: ${memberId}`)
    m.active = false
    m.leftAt = at
    return m
  }

  // ------------------------------------------------------------------ pages
  function registerPage({ path, title, lang = 'zh-CN', declaredScope = [], owner = null, hash = null }) {
    if (store.pagesByPath.has(path)) throw new ReviewError(`page exists: ${path}`)
    const page = {
      id: uuid(), path, title, lang,
      currentHash: hash,
      publishedAt: null,
      tz: 'Asia/Shanghai',
      periodDays: 90,
      createdAt: clock()
    }
    store.pages.set(page.id, page)
    store.pagesByPath.set(path, page)
    for (const pattern of declaredScope) {
      store.declaredScopes.push({ id: uuid(), pageId: page.id, pattern })
    }
    if (owner) {
      if (!store.members.get(owner)) throw new ReviewError(`unknown member: ${owner}`)
      _addHandover(page.id, null, owner, 'manual', clock(), owner)
    }
    return page
  }

  function configureReview(pageId, { tz, periodDays } = {}) {
    const page = store.pages.get(pageId)
    if (tz) page.tz = tz
    if (periodDays) page.periodDays = periodDays
    return page
  }

  function declaredScopeOf(pageId) {
    return store.declaredScopes.filter((s) => s.pageId === pageId).map((s) => s.pattern)
  }

  function currentOwner(pageId, at = clock()) {
    const hs = store.handovers
      .filter((h) => h.pageId === pageId && h.effectiveAt <= at)
      .sort((a, b) => b.effectiveAt - a.effectiveAt || b.seq - a.seq)
    return hs.length ? hs[0].toOwner : null
  }

  function _addHandover(pageId, from, to, reason, at, by) {
    store.handoverSeq += 1
    const row = {
      seq: store.handoverSeq, pageId, fromOwner: from, toOwner: to,
      reason, effectiveAt: at, createdBy: by
    }
    store.handovers.push(row)
    return row
  }

  // ------------------------------------------------------------- review items
  function addItem(pageId, { node, title }) {
    const exists = [...store.items.values()].find((i) => i.pageId === pageId && i.node === node)
    if (exists) return exists
    const item = { id: uuid(), pageId, node, title, active: true, createdAt: clock() }
    store.items.set(item.id, item)
    return item
  }

  function itemsOf(pageId) {
    return [...store.items.values()].filter((i) => i.pageId === pageId && i.active)
  }

  function _latestRevision(itemId) {
    return store.revisions
      .filter((r) => r.itemId === itemId)
      .sort((a, b) => b.revNo - a.revNo)[0] || null
  }

  function ensureRevision(itemId, hash, at = clock()) {
    const existing = store.revisions.find((r) => r.itemId === itemId && r.hash === hash)
    if (existing) return { revision: existing, created: false }
    const revNo = (store.revisions.filter((r) => r.itemId === itemId).length) + 1
    const rev = { id: uuid(), itemId, hash, revNo, createdAt: at }
    store.revisions.push(rev)
    return { revision: rev, created: true }
  }

  // ------------------------------------------------------------ content edit
  /**
   * 正文关键变化：为命中的审阅项建立新版本，旧检查结论不再代表当前版本；
   * 打开的相关任务不能被签收（要求先重验）。幂等：同哈希重复提交不产生新版本。
   */
  function contentChanged(pagePath, { hash, changedNodes = [], at = clock() } = {}) {
    const page = store.pagesByPath.get(pagePath)
    if (!page) throw new ReviewError(`unknown page: ${pagePath}`)
    page.currentHash = hash
    const touched = itemsTouched(changedNodes, itemsOf(page.id))
    const out = []
    for (const item of touched) {
      const { revision, created } = ensureRevision(item.id, `${hash}:${item.node}`, at)
      out.push({ node: item.node, itemId: item.id, newRevision: revision.revNo, bumped: created })
    }
    return { page: page.path, hash, touched: out }
  }

  // --------------------------------------------------------------- releases
  /**
   * 按发布版生成维护任务：每个在版页面一条 release 任务。
   * 幂等：(release_id, page_id) 唯一；重跑同一版本不重复生成。
   */
  function publishRelease({ version, pages = [], at = clock() }) {
    let release = [...store.releases.values()].find((r) => r.version === version)
    if (!release) {
      release = { id: uuid(), version, releasedAt: toDate(at) }
      store.releases.set(release.id, release)
    }
    const generated = []
    for (const p of pages) {
      const page = typeof p === 'string' ? store.pagesByPath.get(p) : store.pages.get(p.id ?? p.pageId)
      if (!page) throw new ReviewError('release references unknown page')
      const dup = store.releasePages.find((rp) => rp.releaseId === release.id && rp.pageId === page.id)
      if (dup) continue // 幂等：重复发布同一版本
      store.releasePages.push({ releaseId: release.id, pageId: page.id, hash: page.currentHash })
      page.publishedAt = toDate(at)
      const task = _createOrMergeTask({
        pageId: page.id,
        type: 'release',
        idemKey: `release:${version}`,
        triggerSource: `release:${version}`,
        dueAt: toDate(at),
        at: toDate(at),
        itemIds: itemsOf(page.id).map((i) => i.id)
      })
      generated.push(task)
    }
    return { release: release.version, tasks: generated }
  }

  // --------------------------------------------------------- task machinery
  function _openTasks(pageId) {
    return [...store.tasks.values()].filter(
      (t) => t.pageId === pageId && (t.status === 'open' || t.status === 'blocked_no_owner')
    )
  }

  function _attachItems(task, itemIds) {
    const set = store.taskItems.get(task.id) || new Set()
    let added = 0
    for (const id of itemIds) {
      if (!set.has(id)) { set.add(id); added++ }
    }
    store.taskItems.set(task.id, set)
    return added
  }

  /**
   * 创建或合并任务。
   * - 同 (page, idemKey) 任务已存在 → 直接返回（重复触发幂等）。
   * - 否则与同页另一个打开的任务合并：
   *     * 已有审阅进展（检查/签收）的任务优先保留，避免证据随合并丢失；
   *     * 否则保留 due 更早者；其余标 superseded，审阅项/来源并入；
   *     * due 取最早；合并 periodic 与 dependency 后类型记为 merged。
   */
  function _taskProgress(taskId) {
    return store.checks.filter((c) => c.taskId === taskId).length
      + store.signoffs.filter((s) => s.taskId === taskId).length
  }

  function _createOrMergeTask({ pageId, type, idemKey, triggerSource, dueAt, at, itemIds = [] }) {
    const same = [...store.tasks.values()].find((t) => t.pageId === pageId && t.idemKey === idemKey)
    if (same) return same // 幂等键命中：不重复建任务

    const task = {
      id: uuid(), pageId, type, triggerSource, idemKey,
      dueAt, status: 'open', currentOwner: currentOwner(pageId, at),
      mergedInto: null, mergedSources: [],
      createdAt: toDate(at), closedAt: null
    }
    if (!task.currentOwner || store.members.get(task.currentOwner)?.active === false) {
      task.status = 'blocked_no_owner'
    }
    store.tasks.set(task.id, task)
    _attachItems(task, itemIds)

    // 与其它打开任务合并（不同 idemKey，可能跨 release/periodic/dependency）
    let survivor = task
    for (const other of _openTasks(pageId)) {
      if (other.id === survivor.id || other.mergedInto) continue
      const sp = _taskProgress(survivor.id)
      const op = _taskProgress(other.id)
      // 进展多者存活；进展相同（通常都为 0）则到期早者存活
      const otherWins = op > sp || (op === sp && other.dueAt < survivor.dueAt)
      if (otherWins) {
        _attachItems(other, [...(store.taskItems.get(survivor.id) || [])])
        other.mergedSources.push({ idemKey: survivor.idemKey, source: survivor.triggerSource, type: survivor.type })
        survivor.mergedInto = other.id
        survivor.status = 'superseded'
        survivor.closedAt = toDate(at)
        other.dueAt = Math.min(other.dueAt, survivor.dueAt)
        if (other.type !== survivor.type) other.type = 'merged'
        // 被阻塞状态不应因合并且丢失：无负责人的幸存者仍阻塞
        if (survivor.status === 'blocked_no_owner' && !other.currentOwner) other.status = 'blocked_no_owner'
        survivor = other
      } else {
        _attachItems(survivor, [...(store.taskItems.get(other.id) || [])])
        survivor.mergedSources.push({ idemKey: other.idemKey, source: other.triggerSource, type: other.type })
        other.mergedInto = survivor.id
        other.status = 'superseded'
        other.closedAt = toDate(at)
        survivor.dueAt = Math.min(survivor.dueAt, other.dueAt)
        if (other.type !== survivor.type) survivor.type = 'merged'
        if (other.status === 'blocked_no_owner' && !survivor.currentOwner) survivor.status = 'blocked_no_owner'
      }
    }
    return survivor
  }

  /**
   * 固定周期扫描：对每页按其 tz 计算周期桶，桶内最多生成一条 periodic 任务。
   * 可安全高频重跑（幂等键含桶起点）。
   */
  function scanCycles({ at = clock(), pagePaths = null } = {}) {
    const pages = pagePaths
      ? pagePaths.map((p) => store.pagesByPath.get(p)).filter(Boolean)
      : [...store.pages.values()]
    const made = []
    for (const page of pages) {
      const bucketStart = periodBucket(toDate(at), page.periodDays, page.tz)
      const due = _cycleDue(page, bucketStart)
      const task = _createOrMergeTask({
        pageId: page.id,
        type: 'periodic',
        idemKey: `cycle:${page.periodDays}d:${bucketStart}`,
        triggerSource: `cycle-scan@${new Date(toDate(at)).toISOString()}`,
        dueAt: due,
        at: toDate(at),
        itemIds: itemsOf(page.id).map((i) => i.id)
      })
      made.push(task)
    }
    return made
  }

  function _cycleDue(page, bucketStart) {
    // 周期任务在桶结束（= 下个桶起点）到期
    const { plusDays } = require_time()
    return plusDays(bucketStart, page.periodDays, page.tz)
  }

  /**
   * 依赖变更触发：依赖发版 → 受影响页面生成 dependency 任务，与未完成的周期任务合并。
   * @param affected: [{ pagePath, itemNodes? }] 依赖图计算出的受影响范围
   */
  function dependencyChanged({ depId, depVersion, affected, at = clock() }) {
    const made = []
    for (const a of affected) {
      const page = store.pagesByPath.get(a.pagePath)
      if (!page) throw new ReviewError(`unknown page: ${a.pagePath}`)
      let ids = itemsOf(page.id).map((i) => i.id)
      if (a.itemNodes) {
        const touched = itemsTouched(a.itemNodes, itemsOf(page.id))
        ids = touched.map((i) => i.id)
        // 依赖变更同样使这些项待重验：建立新版本
        for (const it of touched) ensureRevision(it.id, `${depId}@${depVersion}:${it.node}`, toDate(at))
      }
      const task = _createOrMergeTask({
        pageId: page.id,
        type: 'dependency',
        idemKey: `dep:${depId}:${depVersion}`,
        triggerSource: `dependency:${depId}@${depVersion}`,
        dueAt: toDate(at),
        at: toDate(at),
        itemIds: ids
      })
      made.push(task)
    }
    return made
  }

  // ------------------------------------------------------------- handover
  /**
   * 负责人离职 / 小组调整：转派该人名下所有打开的待办，记流水。
   * to 为 null = 暂无继任，任务进入 blocked_no_owner（不能签收、不丢失）。
   * 注意：只改 task.current_owner；review_signoff.signer 是历史事实，永不覆盖。
   */
  function handoverPages({ pageIds, from, to, reason, at = clock(), by }) {
    const valid = ['leave', 'team_adjust', 'manual']
    if (!valid.includes(reason)) throw new ReviewError(`bad reason: ${reason}`)
    if (to && !store.members.get(to)) throw new ReviewError(`unknown member: ${to}`)
    const log = []
    for (const pageId of pageIds) {
      if (!store.pages.get(pageId)) throw new ReviewError(`unknown page: ${pageId}`)
      _addHandover(pageId, from, to, reason, toDate(at), by)
      for (const t of _openTasks(pageId)) {
        if (from && t.currentOwner !== from) continue
        store.assignmentSeq += 1
        store.assignmentLogs.push({
          seq: store.assignmentSeq, taskId: t.id, fromOwner: t.currentOwner,
          toOwner: to, reason, assignedAt: toDate(at)
        })
        t.currentOwner = to
        t.status = to ? 'open' : 'blocked_no_owner'
        log.push(t)
      }
    }
    return log
  }

  // ---------------------------------------------------------------- checks
  /**
   * 记录一次检查。幂等：同一 (task, item, revision) 已有结论则不重复写。
   * 检查只针对审阅项某版本；修订后必须重新检查。
   */
  function recordCheck({ taskId, itemNode, result, by, note = null, at = clock() }) {
    const task = store.tasks.get(taskId)
    if (!task) throw new ReviewError(`unknown task: ${taskId}`)
    const item = itemsOf(task.pageId).find((i) => i.node === itemNode)
    if (!item) throw new ReviewError(`item not covered by page: ${itemNode}`)
    const rev = _latestRevision(item.id)
    if (!rev) throw new ReviewError(`item has no revision yet: ${itemNode}`)
    if (![...store.taskItems.get(taskId)].includes(item.id)) {
      throw new ReviewError(`task does not cover item: ${itemNode}`)
    }
    if (!store.members.get(by)) throw new ReviewError(`unknown member: ${by}`)
    const dup = store.checks.find(
      (c) => c.taskId === taskId && c.itemId === item.id && c.revisionId === rev.id
    )
    if (dup) return { check: dup, duplicated: true }
    const check = {
      id: uuid(), taskId, itemId: item.id, revisionId: rev.id,
      result, note, checkedBy: by, checkedAt: toDate(at)
    }
    store.checks.push(check)
    return { check, duplicated: false }
  }

  function addEvidence({ checkId = null, signoffId = null, kind, uri, hash = null, by, at = clock() }) {
    const ev = {
      id: uuid(), signoffId, checkId, kind, uri, hash,
      uploadedBy: by, createdAt: toDate(at)
    }
    store.evidences.push(ev)
    return ev
  }

  function _latestCheck(itemId, revisionId) {
    return store.checks
      .filter((c) => c.itemId === itemId && c.revisionId === revisionId)
      .sort((a, b) => b.checkedAt - a.checkedAt)[0] || null
  }

  // --------------------------------------------------------------- signoff
  /**
   * 签收（页脚公开日期的唯一来源）。
   * 规则：
   *  - 覆盖图必须满足声明范围，否则拒绝；
   *  - 正文在待验期发生变化（page.currentHash !== expectedHash / 项有新版无结论）→ 拒绝签收；
   *  - 任一相关项最新版本 fail 或未检查 → partial，签收范围只含真实通过的项；
   *  - 全部通过 → full，任务关闭；
   *  - signer 为当前操作者并固化，后续转派不会改写。
   */
  function signoff({ taskId, by, expectedHash, comment = null, at = clock(), evidence = [] }) {
    const task = store.tasks.get(taskId)
    if (!task) throw new ReviewError(`unknown task: ${taskId}`)
    if (!['open'].includes(task.status)) {
      throw new ReviewError(`task cannot sign off in status: ${task.status}`)
    }
    if (task.currentOwner !== by) {
      throw new ReviewError(`only current owner can sign off: ${task.currentOwner} vs ${by}`)
    }
    const page = store.pages.get(task.pageId)

    // 规则：签收时页面必须未在中途更新（"签收时页面更新"验收点）
    if (page.currentHash !== expectedHash) {
      throw new ReviewError('page changed during review; affected items must be re-verified before sign-off')
    }
    const coveredItemIds = [...store.taskItems.get(taskId)]
    const coveredItems = itemsOf(page.id).filter((i) => coveredItemIds.includes(i.id))

    // 规则：覆盖图必须满足声明范围
    const gaps = coverageGaps(declaredScopeOf(page.id), coveredItems.map((i) => i.node))
    if (gaps.length) {
      throw new ReviewError(`declared scope not covered by review items: ${gaps.join(', ')}`)
    }

    const rows = []
    for (const item of coveredItems) {
      const rev = _latestRevision(item.id)
      if (!rev) throw new ReviewError(`item has no revision: ${item.node}`)
      const check = _latestCheck(item.id, rev.id)
      rows.push({ item, rev, check })
    }

    // 存在"最新版本没有检查结论"的项 → 必须先检查（抽查一处 ≠ 整篇复审）
    const unchecked = rows.filter((r) => !r.check)
    if (unchecked.length) {
      throw new ReviewError(
        `items pending verification on current revision: ${unchecked.map((r) => r.item.node).join(', ')}`
      )
    }

    const passed = rows.filter((r) => r.check.result === 'pass')
    const failed = rows.filter((r) => r.check.result === 'fail')
    const outcome = failed.length === 0 ? 'full' : 'partial'

    // partial 时，签收快照只包含真实通过的项 → 公开日期反映真实完成范围
    const snapshotted = outcome === 'full' ? rows : passed
    const scopeSnapshot = {
      declared: declaredScopeOf(page.id),
      covered: snapshotted.map((r) => r.item.node),
      failed: failed.map((r) => ({ node: r.item.node, note: r.check.note })),
      hash: page.currentHash
    }
    const sign = {
      id: uuid(), taskId: task.id, pageId: page.id, signer: by, outcome,
      scopeSnapshot, pageHash: page.currentHash, comment, signedAt: toDate(at)
    }
    store.signoffs.push(sign)
    for (const r of snapshotted) {
      store.signoffItems.push({ signoffId: sign.id, itemId: r.item.id, revisionId: r.rev.id })
    }
    for (const e of evidence) {
      addEvidence({ signoffId: sign.id, by, ...e, at: toDate(at) })
    }
    if (outcome === 'full') {
      task.status = 'done'
      task.closedAt = toDate(at)
    }
    // partial：任务保持 open，失败项需要整改重验
    return { signoff: sign, passed: passed.length, failed: failed.length }
  }

  // ------------------------------------------------------------ expiry/stale
  /**
   * 到期评估：只产生"信息需核实"状态，不删除/下架任何历史内容与签收。
   * 周期到期：now 超过最近 full 签收 + periodDays（按页面 tz 折算）。
   */
  function evaluatePage(pageId, at = clock()) {
    const page = store.pages.get(pageId)
    const fullSignoffs = store.signoffs
      .filter((s) => s.pageId === pageId && s.outcome === 'full')
      .sort((a, b) => b.signedAt - a.signedAt)
    const latestFull = fullSignoffs[0] || null
    const latestAny = store.signoffs
      .filter((s) => s.pageId === pageId)
      .sort((a, b) => b.signedAt - a.signedAt)[0] || null

    // 正文变化使旧签收失效（需要重验），但仍作为历史事实保留
    const staleByContent = latestAny && latestAny.pageHash !== page.currentHash
    let expiresAt = null
    if (latestFull) {
      const { plusDays } = require_time()
      expiresAt = plusDays(latestFull.signedAt, page.periodDays, page.tz)
    }
    const expired = latestFull ? toDate(at) > expiresAt : true

    const status = expired || staleByContent ? 'needs_verification' : 'verified'
    return {
      page: page.path,
      status,                                  // verified | needs_verification
      latestFullSignoff: latestFull ? _signView(latestFull) : null,
      latestSignoff: latestAny ? _signView(latestAny) : null,
      expiresAt,
      staleByContent: !!staleByContent,
      readable: true                           // 到期≠下架：历史内容始终可读
    }
  }

  function _signView(s) {
    return {
      signer: s.signer, outcome: s.outcome,
      scope: s.scopeSnapshot.covered,
      failed: s.scopeSnapshot.failed || [],
      signedAt: s.signedAt, pageHash: s.pageHash
    }
  }

  // ------------------------------------------------------------- reminders
  /**
   * 提醒任务：due_soon / overdue 每任务每类只发一次，可任意重跑（幂等）。
   */
  function runReminders({ at = clock(), dueSoonMs = 7 * 86400000 } = {}) {
    const sent = []
    for (const task of store.tasks.values()) {
      if (!['open', 'blocked_no_owner'].includes(task.status)) continue
      const overdue = toDate(at) > task.dueAt
      const soon = !overdue && task.dueAt - toDate(at) <= dueSoonMs
      const kinds = overdue ? ['overdue'] : soon ? ['due_soon'] : []
      for (const kind of kinds) {
        const dup = store.reminders.find((r) => r.taskId === task.id && r.kind === kind)
        if (dup) continue
        const row = { id: uuid(), taskId: task.id, kind, sentAt: toDate(at) }
        store.reminders.push(row)
        sent.push(row)
      }
    }
    return sent
  }

  function remindersOf(taskId) {
    return store.reminders.filter((r) => r.taskId === taskId)
  }

  // ------------------------------------------------ maintenance diagnostics
  /**
   * 维护者视图：不只给黄色标签，给出"为何超期"的完整链路。
   */
  function diagnostics(pageId, at = clock()) {
    const page = store.pages.get(pageId)
    const ev = evaluatePage(pageId, at)
    const open = _openTasks(pageId).sort((a, b) => a.dueAt - b.dueAt)
    // 超期天数：优先按全量签收到期日；从未签收则按最早一条逾期待办
    let overdueDays = 0
    if (ev.expiresAt && toDate(at) > ev.expiresAt) {
      overdueDays = diffDays(toDate(at), ev.expiresAt, page.tz)
    } else if (open.length && toDate(at) > open[0].dueAt) {
      overdueDays = diffDays(toDate(at), open[0].dueAt, page.tz)
    }
    return {
      page: page.path,
      status: ev.status,
      owner: currentOwner(pageId, toDate(at)),
      tz: page.tz,
      periodDays: page.periodDays,
      expiresAt: ev.expiresAt,
      earliestDueAt: open[0]?.dueAt ?? null,
      overdueDays,
      staleByContent: ev.staleByContent,
      reasons: _reasons(pageId, open, ev, at),
      openTasks: open.map((t) => ({
        id: t.id, type: t.type, status: t.status, dueAt: t.dueAt,
        source: t.triggerSource, owner: t.currentOwner,
        assignmentTrail: store.assignmentLogs
          .filter((l) => l.taskId === t.id)
          .map((l) => ({ from: l.fromOwner, to: l.toOwner, reason: l.reason, at: l.assignedAt })),
        items: [...store.taskItems.get(t.id)].map((iid) => {
          const item = store.items.get(iid)
          const rev = _latestRevision(iid)
          const check = rev ? _latestCheck(iid, rev.id) : null
          return {
            node: item.node,
            revision: rev?.revNo ?? null,
            pending: !check || check.result !== 'pass',
            lastResult: check?.result ?? null,
            note: check?.note ?? null
          }
        })
      })),
      history: store.signoffs
        .filter((s) => s.pageId === pageId)
        .sort((a, b) => b.signedAt - a.signedAt)
        .map(_signView)
    }
  }

  function _reasons(pageId, openTasks, ev, at) {
    const reasons = []
    if (openTasks.some((t) => t.status === 'blocked_no_owner')) {
      reasons.push('无继任负责人：责任人离职/小组调整后未指定继任，待办被阻塞')
    }
    if (ev.staleByContent) {
      reasons.push('正文或依赖发生关键变化，相关审阅项已升版本，旧结论失效需重验')
    }
    const withFails = openTasks.flatMap((t) =>
      [...store.taskItems.get(t.id)].map((iid) => {
        const rev = _latestRevision(iid)
        const c = rev && _latestCheck(iid, rev.id)
        return { t, c, iid }
      })
    ).filter((x) => x.c && x.c.result === 'fail')
    if (withFails.length) {
      reasons.push(`存在检查失败项未整改：${[...new Set(withFails.map((x) => store.items.get(x.iid).node))].join('、')}`)
    }
    const overdue = openTasks.filter((t) => toDate(at) > t.dueAt)
    if (overdue.length) {
      const t = overdue[0]
      reasons.push(`任务自 ${new Date(t.dueAt).toISOString()} 起超期（来源：${t.triggerSource}）`)
    }
    if (ev.latestFullSignoff && toDate(at) > ev.expiresAt) {
      reasons.push(`固定复审周期(${store.pages.get(pageId).periodDays}天)已到，最近全量签收仅代表当时内容`)
    }
    if (!reasons.length) reasons.push('无异常')
    return reasons
  }

  // --------------------------------------------------------------- public
  /**
   * 公开页脚视图：历史内容始终返回；日期只反映真实完成的签收范围。
   */
  function publicFooter(pagePath, { at = clock(), tz = null } = {}) {
    const page = store.pagesByPath.get(pagePath)
    if (!page) throw new ReviewError(`unknown page: ${pagePath}`)
    const useTz = tz || page.tz
    const ev = evaluatePage(page.id, at)
    const owner = currentOwner(page.id, at)
    return {
      path: page.path,
      owner: owner ? store.members.get(owner)?.displayName ?? owner : null,
      verificationScope: ev.latestSignoff?.scope ?? [],
      failedScope: ev.latestSignoff?.failed ?? [],
      verifiedDate: ev.latestSignoff
        ? { at: ev.latestSignoff.signedAt, display: require_time().formatInTz(ev.latestSignoff.signedAt, useTz) }
        : null,
      fullScopeVerified: ev.latestSignoff?.outcome === 'full' && !ev.staleByContent && !ev.status.startsWith('needs'),
      status: ev.status,
      tz: useTz,
      notice: ev.status === 'needs_verification'
        ? '本文档部分信息需要核实，历史内容仍可正常阅读'
        : null
    }
  }

  // -------------------------------------------------------------- exports
  return {
    store,
    addMember, deactivateMember,
    registerPage, configureReview,
    addItem, ensureRevision, contentChanged,
    publishRelease, scanCycles, dependencyChanged,
    handoverPages, recordCheck, addEvidence, signoff,
    evaluatePage, runReminders, remindersOf,
    diagnostics, publicFooter, currentOwner,
    // test helpers
    _tasksOf: (pageId) => _openTasks(pageId),
    _allTasks: () => [...store.tasks.values()]
  }
}

// 延迟引用，避免循环；time.js 无依赖，直接 import 别名
import * as _t from './time.js'
function require_time() { return _t }
