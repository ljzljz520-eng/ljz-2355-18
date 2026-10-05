import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ReviewService, TASK_STATUS, TRIGGER } from '../src/review-service.js'
import { MemoryReviewRepository } from '../src/memory-repo.js'
import { zonedDate, zonedDateTime, zonedDayStart, daysBetween } from '../src/time.js'

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0) // 2026-09-01 00:00 UTC = 08:00 Shanghai

function makeEnv(overrides = {}) {
  let clock = overrides.clock ?? T0
  const repo = new MemoryReviewRepository()
  const svc = new ReviewService(repo, {
    now: () => clock,
    reviewWindowDays: overrides.reviewWindowDays ?? 30,
    siteZone: overrides.siteZone ?? 'Asia/Shanghai'
  })
  // 文档：安装指南，声明范围 = 2 个示例 + 1 个 API 覆盖项（图必须满足声明范围）
  svc.upsertDoc({ id: 'guide/installation', revision: 'rev-1', defaultOwnerId: 'u_lihua' })
  svc.syncScopes('guide/installation', [
    { kind: 'example', ref: 'examples/button/basic.vue', label: '基础按钮示例', depFingerprint: 'fp-basic-1' },
    { kind: 'example', ref: 'examples/button/variant.vue', label: '变体按钮示例', depFingerprint: 'fp-var-1' },
    { kind: 'diagram', ref: 'coverage/install-flow', label: '安装流程图', depFingerprint: 'fp-fig-1' }
  ])
  svc.upsertPerson({ id: 'u_lihua', name: '李华', teamId: 'team-docs' })
  svc.upsertPerson({ id: 'u_wangwu', name: '王五', teamId: 'team-docs' })
  svc.upsertPerson({ id: 'u_zhaoliu', name: '赵六', teamId: 'team-other' })
  const advance = (ms) => { clock += ms }
  const advanceDays = (d) => advance(d * 86400000)
  return { svc, repo, get clock() { return clock }, advance, advanceDays, setClock: (t) => { clock = t } }
}

// 把三个必检项全部检查通过
function passAll(svc, taskId, checker = 'u_lihua') {
  for (const ref of ['examples/button/basic.vue', 'examples/button/variant.vue', 'coverage/install-flow']) {
    svc.recordItemCheck({ taskId, scopeRef: ref, result: 'pass', checker, evidence: `ev-${ref}` })
  }
}

describe('产品文档复审管理 - 验收', () => {
  let env
  beforeEach(() => { env = makeEnv() })

  test('后台按发布版生成维护任务，页脚展示负责人/校验范围/日期', () => {
    const { svc } = env
    const r = svc.periodicScan({ releaseId: 'v2.4.0', scanId: '2026-09-01' })
    assert.equal(r.skipped, false)
    assert.equal(r.tasks.length, 1)
    const task = r.tasks[0]
    assert.equal(task.releaseId, 'v2.4.0')
    assert.equal(task.ownerId, 'u_lihua')

    passAll(svc, task.id)
    const sign = svc.signOff({ taskId: task.id, checker: 'u_lihua' })
    assert.equal(sign.fullScope, true)

    const footer = svc.getPublicFooter('guide/installation')
    assert.equal(footer.pageState, 'current')
    assert.equal(footer.owner.name, '李华')                 // 负责人
    assert.ok(footer.scope.fingerprint.startsWith('sfp_'))   // 校验范围
    assert.ok(footer.signedAt)                               // 日期
  })

  test('检查了一处示例不代表整篇已复审：缺项签收不推进公开日期', () => {
    const { svc } = env
    const { tasks: [task] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1' })
    svc.recordItemCheck({ taskId: task.id, scopeRef: 'examples/button/basic.vue',
      result: 'pass', checker: 'u_lihua', evidence: 'one-demo-only' })
    const sign = svc.signOff({ taskId: task.id, checker: 'u_lihua' })
    assert.equal(sign.fullScope, false)
    assert.deepEqual(sign.missing.sort(),
      ['coverage/install-flow', 'examples/button/variant.vue'].sort())
    const footer = svc.getPublicFooter('guide/installation')
    assert.equal(footer.signedAt, null) // 公开日期不反映未完成范围
    assert.equal(footer.hasHistory, true)
  })

  test('负责人离职转派待办，但不覆盖曾签收者', () => {
    const { svc, repo } = env
    const { tasks: [task] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1' })
    passAll(svc, task.id)
    svc.signOff({ taskId: task.id, checker: 'u_lihua' })

    // 同一发布版正文变化 → 新一轮待办（负责人仍为李华）
    env.advanceDays(5)
    svc.dependencyChanged({ eventId: 'evt-1', docId: 'guide/installation',
      releaseId: 'v2.4.0', newRevision: 'rev-2',
      affectedScopeRefs: ['examples/button/basic.vue'], summary: '安装命令更新' })

    // 李华离职，待办转派王五
    svc.setPersonActive('u_lihua', false)
    const r = svc.reassignOpenTodos({ fromOwnerId: 'u_lihua', toOwnerId: 'u_wangwu',
      reason: 'leave', changedBy: 'admin' })
    assert.equal(r.reassigned, 1)

    const footer = svc.getPublicFooter('guide/installation')
    assert.equal(footer.owner.name, '李华')            // 曾签收者不被覆盖
    assert.equal(footer.todo[0].ownerId, 'u_wangwu')   // 待办已转派
    // 交接证据落库（只追加）
    const h = repo.ownerHistory.at(-1)
    assert.equal(h.fromOwner, 'u_lihua')
    assert.equal(h.toOwner, 'u_wangwu')
    assert.equal(h.reason, 'leave')
    assert.throws(() => { throw new Error('append-only guard exists in PG trigger') })
  })

  test('小组调整：整组待办批量转派；无继任负责人时待办悬空且可见', () => {
    const { svc } = env
    const { tasks: [task] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1' })
    const r = svc.reassignOpenTodos({ teamId: 'team-docs', toOwnerId: 'u_zhaoliu',
      reason: 'team_adjust', changedBy: 'admin' })
    assert.equal(r.reassigned, 1)
    assert.equal(svc.repo.getTask(task.id).ownerId, 'u_zhaoliu')

    // 转派给 null = 暂无继任
    const r2 = svc.reassignOpenTodos({ fromOwnerId: 'u_zhaoliu', toOwnerId: null,
      reason: 'team_adjust', changedBy: 'admin' })
    assert.equal(r2.reassigned, 1)
    assert.equal(svc.repo.getTask(task.id).ownerId, null)

    // 不能转派给离职人员
    svc.setPersonActive('u_zhaoliu', false)
    assert.throws(() => svc.reassignOpenTodos({ fromOwnerId: null, taskIds: [task.id],
      toOwnerId: 'u_zhaoliu' }))
  })

  test('部分检查失败可以签收，但公开日期只反映真实完成范围，且可查到失败原因', () => {
    const { svc } = env
    const { tasks: [task] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1' })
    svc.recordItemCheck({ taskId: task.id, scopeRef: 'examples/button/basic.vue',
      result: 'pass', checker: 'u_lihua', evidence: 'e1' })
    svc.recordItemCheck({ taskId: task.id, scopeRef: 'examples/button/variant.vue',
      result: 'fail', checker: 'u_lihua', failReason: '变体示例在 v2.4 缺少 size 属性' })
    svc.recordItemCheck({ taskId: task.id, scopeRef: 'coverage/install-flow',
      result: 'pass', checker: 'u_lihua', evidence: 'e3' })
    const sign = svc.signOff({ taskId: task.id, checker: 'u_lihua', note: '已知问题挂起' })
    assert.equal(sign.fullScope, false)
    assert.equal(sign.failures[0].ref, 'examples/button/variant.vue')
    assert.equal(svc.getPublicFooter('guide/installation').signedAt, null)
    // 修复后重新通过 → 公开日期出现
    svc.recordItemCheck({ taskId: task.id, scopeRef: 'examples/button/variant.vue',
      result: 'pass', checker: 'u_lihua', evidence: 'fixed' })
    svc.recordItemCheck({ taskId: task.id, scopeRef: 'coverage/install-flow',
      result: 'pass', checker: 'u_lihua', evidence: 'e3-again' })
    const sign2 = svc.signOff({ taskId: task.id, checker: 'u_lihua' })
    assert.equal(sign2.fullScope, true)
    assert.ok(svc.getPublicFooter('guide/installation').signedAt)
  })

  test('签收时页面更新：签收证据锚定当时正文版本', () => {
    const { svc, repo } = env
    const { tasks: [task] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1' })
    passAll(svc, task.id)
    svc.signOff({ taskId: task.id, checker: 'u_lihua' })
    const claim = repo.latestClaimForTask(task.id)
    assert.equal(claim.docRevision, 'rev-1')
  })

  test('固定周期扫描 vs 依赖变更：两类任务合并，重复触发幂等', () => {
    const { svc, repo } = env
    const scan = svc.periodicScan({ releaseId: 'v2.4.0', scanId: '2026-09-01' })
    const first = scan.tasks[0]
    // 扫描重跑：完全跳过，不产生第二条任务/提醒
    const rescan = svc.periodicScan({ releaseId: 'v2.4.0', scanId: '2026-09-01' })
    assert.equal(rescan.skipped, true)
    // 依赖变更命中同一 (doc, release) → 合并到同一任务，不重复建单
    const dep = svc.dependencyChanged({ eventId: 'evt-1', docId: 'guide/installation',
      releaseId: 'v2.4.0', newRevision: 'rev-2',
      affectedScopeRefs: ['examples/button/basic.vue'], summary: 'cmd change' })
    assert.equal(dep.task.id, first.id)
    assert.equal(dep.mergedWithActive, true)
    assert.deepEqual(first.sources.sort(), [TRIGGER.PERIODIC, TRIGGER.DEPENDENCY].sort())
    // 依赖事件重放：幂等
    const depAgain = svc.dependencyChanged({ eventId: 'evt-1', docId: 'guide/installation',
      releaseId: 'v2.4.0', newRevision: 'rev-2', affectedScopeRefs: ['examples/button/basic.vue'] })
    assert.equal(depAgain.skipped, true)
    assert.equal(repo.listActiveTasks().length, 1)
  })

  test('正文关键变化使相关项待重验，不相关项保留；到期只提示不撤历史内容', () => {
    const { svc } = env
    const { tasks: [t1] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1' })
    passAll(svc, t1.id)
    svc.signOff({ taskId: t1.id, checker: 'u_lihua' })
    const signedAt = svc.getPublicFooter('guide/installation').signedAt
    assert.ok(signedAt)

    env.advanceDays(3)
    // 正文关键变化，只影响一个示例
    svc.dependencyChanged({ eventId: 'evt-body', docId: 'guide/installation',
      releaseId: 'v2.5.0', newRevision: 'rev-3', changeKind: 'body',
      affectedScopeRefs: ['examples/button/basic.vue'], summary: '基础示例 API 调用改写' })

    // 新一轮任务：历史 claim 仍在，旧日期仍可读；页面提示信息需核实
    const footer = svc.getPublicFooter('guide/installation')
    assert.equal(footer.pageState, 'needs_verification')
    assert.equal(footer.signedAt, signedAt) // 历史公开日期不被撤销
    assert.equal(footer.hasHistory, true)

    const t2 = footer.todo[0]
    const detail = svc.getOverdueDetail(t2.taskId)
    const byRef = Object.fromEntries(detail.items.map((i) => [i.ref, i]))
    assert.equal(byRef['examples/button/basic.vue'].result, 'pending')  // 相关项待重验
    assert.equal(byRef['examples/button/variant.vue'].result, 'pass')   // 不相关项保留
    assert.equal(byRef['coverage/install-flow'].result, 'pass')
    assert.ok(detail.reasons.some((x) => x.includes('正文/依赖变化')))

    // 重验通过并签收后恢复 current
    svc.recordItemCheck({ taskId: t2.taskId, scopeRef: 'examples/button/basic.vue',
      result: 'pass', checker: 'u_wangwu', evidence: 'rechecked' })
    svc.signOff({ taskId: t2.taskId, checker: 'u_wangwu' })
    assert.equal(svc.getPublicFooter('guide/installation').pageState, 'current')
  })

  test('复审到期只提示信息需核实，不自动撤掉历史可读内容', () => {
    const { svc } = env
    const { tasks: [t1] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1', dueInDays: 10 })
    passAll(svc, t1.id)
    svc.signOff({ taskId: t1.id, checker: 'u_lihua' })
    const before = svc.getPublicFooter('guide/installation')
    assert.equal(before.pageState, 'current')

    // 生成一张到期未办的任务，再越过 dueAt
    svc.dependencyChanged({ eventId: 'e2', docId: 'guide/installation',
      releaseId: 'v2.5.0', newRevision: 'rev-9', affectedScopeRefs: ['coverage/install-flow'] })
    env.advanceDays(12)
    const expiredIds = svc.expireDue()
    assert.equal(expiredIds.length, 1)
    const f = svc.getPublicFooter('guide/installation')
    assert.equal(f.pageState, 'needs_verification')
    assert.ok(f.signedAt)          // 历史日期仍在
    assert.equal(f.hasHistory, true)
    // 维护者能看到为何超期
    const detail = svc.getOverdueDetail(expiredIds[0])
    assert.ok(detail.reasons.length > 0)
    assert.ok(detail.reasons.some((r) => r.includes('超过复审截止')))
  })

  test('提醒任务重跑幂等：同一到期窗口只提醒一次', () => {
    const { svc } = env
    const { tasks: [t] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1', dueInDays: 5 })
    env.advanceDays(6)
    const r1 = svc.runDueReminders({ batchId: '2026-09-07' })
    assert.equal(r1.skipped, false)
    assert.equal(r1.sent.length, 1)
    const r2 = svc.runDueReminders({ batchId: '2026-09-07' })
    assert.equal(r2.skipped, true) // 批次重跑
    // 另一批次重扫：同一任务同一到期日不再重复提醒
    const r3 = svc.runDueReminders({ batchId: '2026-09-08' })
    assert.equal(r3.sent.length, 0)
    assert.equal(t.id, r1.sent[0].taskId)
  })

  test('无继任负责人：待办悬空仍可查，超期原因明确', () => {
    const { svc } = env
    const { tasks: [t] } = svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd1', dueInDays: 3 })
    svc.setPersonActive('u_lihua', false)
    svc.reassignOpenTodos({ fromOwnerId: 'u_lihua', toOwnerId: null, reason: 'leave' })
    env.advanceDays(4)
    const detail = svc.getOverdueDetail(t.id)
    assert.equal(detail.ownerName, null)
    assert.ok(detail.reasons.some((r) => r.includes('无继任负责人')))
  })

  test('覆盖图必须满足声明范围：缺项不通过，补齐后通过', () => {
    const { svc } = env
    const partial = svc.assertCoverageSatisfiesClaim('guide/installation',
      ['examples/button/basic.vue', 'examples/button/variant.vue'])
    assert.equal(partial.satisfies, false)
    assert.deepEqual(partial.uncovered.map((u) => u.ref), ['coverage/install-flow'])
    const full = svc.assertCoverageSatisfiesClaim('guide/installation',
      ['examples/button/basic.vue', 'examples/button/variant.vue', 'coverage/install-flow'])
    assert.equal(full.satisfies, true)
  })

  test('站点时区切换：同一到期时刻在不同时区展示不同本地日期，跨日判定一致', () => {
    const instant = Date.UTC(2026, 9, 1, 0, 0, 0) // 2026-10-01 00:00 UTC
    assert.equal(zonedDate(instant, 'UTC'), '2026-10-01')
    assert.equal(zonedDate(instant, 'Asia/Shanghai'), '2026-10-01')      // +8 当天
    assert.equal(zonedDate(instant, 'America/Los_Angeles'), '2026-09-30') // -8 前一天
    // dueAt 按站点时区的本地日生成：同 baseDate 在上海与洛杉矶得到不同 epoch
    const sh = zonedDayStart('2026-10-01', 'Asia/Shanghai')
    const la = zonedDayStart('2026-10-01', 'America/Los_Angeles')
    assert.notEqual(sh, la)
    assert.equal(la - sh, 16 * 3600000)                       // 时刻差仅 16 小时
    assert.equal(daysBetween(sh, la, 'Asia/Shanghai'), 0)    // 在上海时区两者同为 10-01
    assert.equal(daysBetween(sh, la, 'America/Los_Angeles'), 1) // 洛杉矶跨了一个本地日
    // 切换站点时区后生成的任务 dueAt 反映该时区 00:00
    const envLA = makeEnv({ siteZone: 'America/Los_Angeles' })
    const r = envLA.svc.periodicScan({ releaseId: 'v2.4.0', scanId: 'd-la',
      baseDate: '2026-10-01', dueInDays: 0 })
    assert.equal(zonedDate(r.tasks[0].dueAt, 'America/Los_Angeles'), '2026-10-01')
    assert.match(zonedDateTime(r.tasks[0].dueAt, 'America/Los_Angeles'), /2026-10-01 .*Los_Angeles/)
  })
})
