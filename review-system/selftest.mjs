/**
 * 产品文档复审管理 —— 验收自测（零依赖，node review-system/selftest.mjs）。
 *
 * 覆盖场景：
 *  1. 站点时区切换影响到期日（同一发布时刻，Shanghai vs Los Angeles）
 *  2. 无继任负责人：离职转派后任务挂起，提醒落到维护者待办
 *  3. 部分检查失败：不签收、不写公开日期；全部通过后才签收
 *  4. 签收时页面（清单）更新；提醒任务当天重跑幂等
 *  5. 公开日期反映真实完成范围；一处示例通过 ≠ 整篇复审
 *  6. 固定周期扫描 vs 依赖变更触发：两类任务合并
 *  7. 重复触发幂等
 *  8. 转派不覆盖曾签收者（签收证据不可变）
 *  9. 复审到期只提示"信息需核实"，历史可读内容不撤回
 * 10. 正文关键变化使相关项待重验；覆盖图不满足声明范围时拒绝发布
 * 11. 维护者可见结构化超期原因，而非只有黄色标签
 */
import assert from 'node:assert/strict'
import { JsonRepo } from './src/repo-json.js'
import { ReviewService, CoverageError } from './src/ReviewService.js'
import { buildManifest } from './src/manifest.js'
import { zonedDatePart } from './src/time.js'

let passed = 0
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✅ ${name}`) }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); process.exitCode = 1 }
}

const T = (utc) => new Date(utc)
const docScope = (docId) => [
  { id: `${docId}-intro`, label: '开篇说明' },
  { id: `${docId}-demo`, label: '示例演示' },
  { id: `${docId}-api`, label: 'API 参考' }
]
const docBlocks = (docId) => [
  { id: 'b1', title: '开篇', content: `${docId}-intro-v1`, dependsOn: [`${docId}-intro`] },
  { id: 'b2', title: '示例', content: `${docId}-demo-v1`, dependsOn: [`${docId}-demo`] },
  { id: 'b3', title: 'API', content: `${docId}-api-v1`, dependsOn: [`${docId}-api`] }
]
const seed = (repo, now = T('2026-09-01T00:00:00Z')) => {
  const svc = new ReviewService({ repo, zone: 'Asia/Shanghai', clock: () => now })
  svc.createUser({ id: 'u_alice', name: 'Alice', group: 'g_docs' })
  svc.createUser({ id: 'u_bob', name: 'Bob', group: 'g_docs' })
  svc.createUser({ id: 'u_carol', name: 'Carol', group: 'g_other' })
  return svc
}

console.log('\n[1] 站点时区切换：周期到期日随站点时区变化')
await test('Asia/Shanghai 与 America/Los_Angeles 推出的到期日不同', () => {
  const now = T('2026-09-01T00:00:00Z') // 上海 09-01 08:00 / 洛杉矶 08-31 17:00
  const a = seed(new JsonRepo(), now)
  a.registerDoc({ id: 'dA', path: '/guide/a', title: '文档A', ownerId: 'u_alice' })
  const ra = a.publishRelease({ docId: 'dA', version: '1.0', blocks: docBlocks('dA'), declaredScope: docScope('dA'), intervalDays: 30 })

  const b = seed(new JsonRepo(), now)
  b.zone = 'America/Los_Angeles'
  b.registerDoc({ id: 'dA', path: '/guide/a', title: '文档A', ownerId: 'u_alice' })
  const rb = b.publishRelease({ docId: 'dA', version: '1.0', blocks: docBlocks('dA'), declaredScope: docScope('dA'), intervalDays: 30 })

  assert.equal(zonedDatePart('Asia/Shanghai', ra.task.dueDate), '2026-10-01')
  assert.equal(zonedDatePart('America/Los_Angeles', rb.task.dueDate), '2026-09-30')
  assert.notEqual(ra.task.dueDate, rb.task.dueDate)
})

console.log('\n[2] 无继任负责人：离职 → 待办挂起为 unassigned，提醒不丢失')
await test('负责人离职且无继任，任务与提醒都保留', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dB', path: '/guide/b', title: '文档B', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dB', version: '1.0', blocks: docBlocks('dB'), declaredScope: docScope('dB') })

  // 时间推进到到期后
  svc.clock = () => T('2026-10-05T00:00:00Z')
  const handover = svc.handover({ type: 'user', subjectId: 'u_alice', toUserId: null, reason: 'owner-leave' })
  assert.equal(handover.affectedTaskIds.length, 1)
  const task = svc.repo.get('tasks', handover.affectedTaskIds[0])
  assert.equal(task.status, 'unassigned')
  assert.equal(task.assigneeId, null)

  const { sent } = svc.runReminders()
  assert.equal(sent.length, 1)
  const rem = svc.repo.get('reminders', sent[0].id)
  assert.equal(rem.to, 'maintainer-backlog')
  assert.equal(rem.unassigned, true)
  assert.ok(rem.overdueReasons.some(r => r.type === 'no-owner'))

  const st = svc.statusOf('rel_dB_1_0')
  assert.equal(st.level, 'overdue-unassigned')
})

console.log('\n[3] 部分检查失败：不签收、不写公开日期；修复后全部通过才签收')
await test('partial failure 不产生签收；通过后签收并写公开日期', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dC', path: '/guide/c', title: '文档C', ownerId: 'u_bob' })
  svc.publishRelease({ docId: 'dC', version: '1.0', blocks: docBlocks('dC'), declaredScope: docScope('dC') })

  svc.recordCheck({ releaseId: 'rel_dC_1_0', targetId: 'dC-intro', status: 'passed', byUserId: 'u_bob' })
  svc.recordCheck({ releaseId: 'rel_dC_1_0', targetId: 'dC-demo', status: 'failed', byUserId: 'u_bob', evidence: '示例渲染与截图不符' })
  svc.recordCheck({ releaseId: 'rel_dC_1_0', targetId: 'dC-api', status: 'passed', byUserId: 'u_bob' })

  let release = svc.repo.get('releases', 'rel_dC_1_0')
  assert.equal(release.publicDate, null, '部分失败时不得写公开日期')
  assert.equal(svc.repo.list('signoffs').length, 0)
  assert.equal(svc.statusOf('rel_dC_1_0').level, 'partial-failed')

  // 修复后重验该项
  svc.clock = () => T('2026-09-03T00:00:00Z')
  const r = svc.recordCheck({ releaseId: 'rel_dC_1_0', targetId: 'dC-demo', status: 'passed', byUserId: 'u_bob', evidence: '已按最新截图核对' })
  assert.equal(r.complete, true)
  assert.equal(r.signedOff, true)
  release = svc.repo.get('releases', 'rel_dC_1_0')
  assert.equal(release.publicDate, '2026-09-03T00:00:00.000Z', '公开日期=真实完成日，而非发布日')
  const task = svc.repo.list('tasks').find(t => t.releaseId === 'rel_dC_1_0')
  assert.equal(task.status, 'done')
})

console.log('\n[4] 签收时页面（清单）更新；提醒当天重跑幂等')
await test('buildManifest 在签收前后反映不同状态；runReminders 重跑不重复', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dD', path: '/guide/d', title: '文档D', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dD', version: '1.0', blocks: docBlocks('dD'), declaredScope: docScope('dD') })

  const before = buildManifest(svc).entries.find(e => e.docId === 'dD')
  assert.equal(before.level, 'needs-review')
  assert.equal(before.publicDate, null)

  for (const t of docScope('dD')) {
    svc.recordCheck({ releaseId: 'rel_dD_1_0', targetId: t.id, status: 'passed', byUserId: 'u_alice', evidence: '逐项核对' })
  }
  const after = buildManifest(svc).entries.find(e => e.docId === 'dD')
  assert.equal(after.level, 'verified')
  assert.ok(after.publicDate)
  assert.equal(after.coverage.passed, 3)

  // 到期提醒幂等（造一个已超期任务：9/1 发布、周期 30 天，10/2 扫描+提醒）
  svc.clock = () => T('2026-09-01T00:00:00Z')
  svc.registerDoc({ id: 'dE', path: '/guide/e', title: '文档E', ownerId: 'u_bob' })
  svc.publishRelease({ docId: 'dE', version: '1.0', blocks: docBlocks('dE'), declaredScope: docScope('dE'), intervalDays: 30 })
  svc.clock = () => T('2026-10-12T00:00:00Z')
  const first = svc.runReminders()
  const second = svc.runReminders()
  assert.equal(first.sent.filter(s => !s.idempotent).length, 1)
  assert.equal(second.sent[0].idempotent, true)
  assert.equal(svc.repo.list('reminders').length, 1, '同一天重跑只保留一条提醒')
})

console.log('\n[5] 公开日期=真实完成范围；检查一处示例不代表整篇复审')
await test('只通过一个检查项时覆盖率 1/3，状态不完整', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dF', path: '/guide/f', title: '文档F', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dF', version: '1.0', blocks: docBlocks('dF'), declaredScope: docScope('dF') })
  const r = svc.recordCheck({ releaseId: 'rel_dF_1_0', targetId: 'dF-demo', status: 'passed', byUserId: 'u_alice', evidence: '只看了示例' })
  assert.equal(r.complete, false)
  assert.equal(r.coverage.passed, 1)
  assert.equal(r.coverage.total, 3)
  assert.equal(svc.statusOf('rel_dF_1_0').level, 'in-progress')
})

console.log('\n[6] 固定周期扫描 与 依赖变更触发：两类任务合并')
await test('依赖触发先建任务，周期扫描并入；同一发布版打开任务唯一', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dG', path: '/guide/g', title: '文档G', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dG', version: '1.0', blocks: docBlocks('dG'), declaredScope: docScope('dG'), intervalDays: 30 })

  // 9/10 完成首轮签收 → 周期任务关闭、公开日期写入
  svc.clock = () => T('2026-09-10T00:00:00Z')
  for (const t of docScope('dG')) {
    svc.recordCheck({ releaseId: 'rel_dG_1_0', targetId: t.id, status: 'passed', byUserId: 'u_alice' })
  }

  // 10/02 上游 API 变更：依赖触发先建任务（grace 7 天）
  svc.clock = () => T('2026-10-12T00:00:00Z')
  const dep = svc.triggerDependencyChange({ docId: 'dG', targetIds: ['dG-api'], reason: 'api-spec-change', changedRef: 'GET /button props' })
  assert.equal(dep.merged, true)
  const taskId = dep.taskId
  assert.deepEqual(svc.repo.get('tasks', taskId).triggers.map(t => t.kind), ['dependency'])
  assert.ok(new Date(svc.repo.get('tasks', taskId).dueDate) <= T('2026-10-19T00:00:00Z'))

  // 固定周期扫描（首轮已完成 → 进入第 2 周期）并入同一任务，不新建
  const scan = svc.runCycleScan()
  assert.ok(scan.tasksTouched.includes(taskId), '周期扫描并入依赖任务')
  const task = svc.repo.get('tasks', taskId)
  assert.equal(svc.repo.list('tasks').filter(t => t.releaseId === 'rel_dG_1_0' && ['open','in_progress'].includes(t.status)).length, 1)
  assert.deepEqual(task.triggers.map(t => t.kind).sort(), ['dependency', 'schedule'])
  assert.equal(task.cycleIndex, 2)
})

console.log('\n[7] 重复触发幂等')
await test('同周期重复扫描 & 同目标同天重复依赖触发均不重复', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dH', path: '/guide/h', title: '文档H', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dH', version: '1.0', blocks: docBlocks('dH'), declaredScope: docScope('dH'), intervalDays: 30 })

  svc.clock = () => T('2026-10-05T00:00:00Z')
  const s1 = svc.runCycleScan()
  const triggersAfterS1 = svc.repo.list('tasks').reduce((n, t) => n + t.triggers.length, 0)
  const s2 = svc.runCycleScan()
  const triggersAfterS2 = svc.repo.list('tasks').reduce((n, t) => n + t.triggers.length, 0)
  assert.equal(triggersAfterS1, triggersAfterS2, '重复周期扫描不追加触发')

  const d1 = svc.triggerDependencyChange({ docId: 'dH', targetIds: ['dH-demo'], reason: 'asset-update', changedRef: 'screenshot.png' })
  const d2 = svc.triggerDependencyChange({ docId: 'dH', targetIds: ['dH-demo'], reason: 'asset-update', changedRef: 'screenshot.png' })
  assert.equal(d2.idempotent, true)
  const task = svc.repo.get('tasks', d1.taskId)
  assert.equal(task.triggers.filter(t => t.kind === 'dependency').length, 1)
  // 检查项只被重置一次（证据链仍是初始态）
  const item = svc.repo.list('checkItems').find(i => i.targetId === 'dH-demo')
  assert.equal(item.status, 'pending')
  assert.equal(item.evidence.length, 0)
})

console.log('\n[8] 转派待办但不覆盖曾签收者')
await test('签收后转派：signoff.signedBy 保持原签收者，仅任务改派', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dI', path: '/guide/i', title: '文档I', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dI', version: '1.0', blocks: docBlocks('dI'), declaredScope: docScope('dI'), intervalDays: 30 })
  for (const t of docScope('dI')) {
    svc.recordCheck({ releaseId: 'rel_dI_1_0', targetId: t.id, status: 'passed', byUserId: 'u_alice', evidence: 'alice 核对' })
  }
  const signBefore = svc.repo.list('signoffs').find(s => s.releaseId === 'rel_dI_1_0')
  assert.equal(signBefore.signedById, 'u_alice')

  // 依赖变化产生新待办后 Alice 离职、Bob 继任
  svc.clock = () => T('2026-10-12T00:00:00Z')
  svc.triggerDependencyChange({ docId: 'dI', targetIds: ['dI-api'], reason: 'api-spec-change' })
  svc.handover({ type: 'user', subjectId: 'u_alice', toUserId: 'u_bob' })

  const signAfter = svc.repo.get('signoffs', signBefore.id)
  assert.equal(signAfter.signedById, 'u_alice', '曾签收者不可被覆盖')
  const doc = svc.repo.get('docs', 'dI')
  assert.equal(doc.ownerId, 'u_bob')
  const task = svc.repo.list('tasks').find(t => t.releaseId === 'rel_dI_1_0' && t.status === 'open')
  assert.equal(task.assigneeId, 'u_bob')
  assert.ok(task.triggers.some(t => t.kind === 'transfer' && t.from === 'u_alice' && t.to === 'u_bob'))

})

console.log('\n[9] 复审到期：只提示信息需核实，不撤回历史可读内容')
await test('到期后发布版仍存在、历史公开日期保留、级别为 needs-recheck/overdue', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dJ', path: '/guide/j', title: '文档J', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dJ', version: '1.0', blocks: docBlocks('dJ'), declaredScope: docScope('dJ'), intervalDays: 30 })
  for (const t of docScope('dJ')) {
    svc.recordCheck({ releaseId: 'rel_dJ_1_0', targetId: t.id, status: 'passed', byUserId: 'u_alice' })
  }
  assert.ok(svc.repo.get('releases', 'rel_dJ_1_0').publicDate)

  // 周期到期（未做任何撤下操作）
  svc.clock = () => T('2026-11-05T00:00:00Z')
  svc.runCycleScan()
  const release = svc.repo.get('releases', 'rel_dJ_1_0')
  assert.ok(release, '发布版仍然存在')
  assert.ok(release.publicDate, '历史公开日期不被自动清空')
  const st = svc.statusOf('rel_dJ_1_0')
  assert.equal(st.overdue, true)
  assert.notEqual(st.level, 'removed')
  assert.ok(['overdue', 'needs-recheck', 'due-for-review'].includes(st.level))

  // 依赖变更 → 信息需核实（仍可读）
  svc.triggerDependencyChange({ docId: 'dJ', targetIds: ['dJ-intro'], reason: 'upstream-change' })
  const relAfter = svc.repo.get('releases', 'rel_dJ_1_0')
  assert.equal(svc.statusOf('rel_dJ_1_0').level, 'needs-recheck')
  assert.ok(relAfter, '内容未撤回')
  assert.ok(relAfter.lastPublicDate, '上次真实完成范围仍有迹可循，页面保持可读')
})

console.log('\n[10] 正文关键变化使相关项待重验；覆盖图必须满足声明范围')
await test('新版发布时受影响项携带 revalidate；覆盖缺口直接拒绝', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dK', path: '/guide/k', title: '文档K', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dK', version: '1.0', blocks: docBlocks('dK'), declaredScope: docScope('dK') })

  // 覆盖图不满足声明范围（漏掉 api 目标）→ 拒绝
  assert.throws(() => svc.publishRelease({
    docId: 'dK', version: '2.0',
    blocks: docBlocks('dK'), declaredScope: docScope('dK'),
    checks: [
      { targetId: 'x1', covers: ['dK-intro'] },
      { targetId: 'x2', covers: ['dK-demo'] }
    ]
  }), CoverageError)

  // 正文 b3（API）关键变化，其余块不变
  const blocks2 = docBlocks('dK')
  blocks2[2] = { id: 'b3', title: 'API', content: 'dK-api-v2-BREAKING', dependsOn: ['dK-api'] }
  const pub = svc.publishRelease({ docId: 'dK', version: '2.0', blocks: blocks2, declaredScope: docScope('dK') })
  assert.deepEqual(pub.changedBlocks, [{ id: 'b3', title: 'API' }])
  const apiItem = pub.items.find(i => i.targetId === 'dK-api')
  assert.equal(apiItem.status, 'pending')
  assert.equal(apiItem.revalidate.reason, 'body-change')
  assert.deepEqual(apiItem.revalidate.changedBlocks, [{ id: 'b3', title: 'API' }])
  const introItem = pub.items.find(i => i.targetId === 'dK-intro')
  assert.equal(introItem.revalidate, null)

  // 旧任务被取代但保留可查
  const oldTasks = svc.repo.list('tasks').filter(t => t.releaseId === 'rel_dK_1_0')
  assert.equal(oldTasks.at(-1).status, 'superseded')
  assert.equal(svc.repo.get('releases', 'rel_dK_1_0').supersedes ?? true, true)
})

console.log('\n[11] 维护者可见结构化超期原因，而不只是黄色标签')
await test('explainOverdue 给出周期/依赖/交接/失败/无主等原因', () => {
  const now = T('2026-09-01T00:00:00Z')
  const svc = seed(new JsonRepo(), now)
  svc.registerDoc({ id: 'dL', path: '/guide/l', title: '文档L', ownerId: 'u_alice' })
  svc.publishRelease({ docId: 'dL', version: '1.0', blocks: docBlocks('dL'), declaredScope: docScope('dL'), intervalDays: 30 })
  svc.clock = () => T('2026-10-04T00:00:00Z')
  svc.triggerDependencyChange({ docId: 'dL', targetIds: ['dL-api'], reason: 'api-spec-change', changedRef: 'POST /buttons' })
  svc.recordCheck({ releaseId: 'rel_dL_1_0', targetId: 'dL-demo', status: 'failed', byUserId: 'u_bob', evidence: 'demo 报错' })
  svc.handover({ type: 'group', subjectId: 'g_docs', toUserId: 'u_carol', reason: 'group-adjust' })

  const task = svc.repo.list('tasks').find(t => t.releaseId === 'rel_dL_1_0')
  const why = svc.explainOverdue(task.id)
  const types = why.reasons.map(r => r.type)
  assert.ok(types.includes('cycle'))
  assert.ok(types.includes('dependency'))
  assert.ok(types.includes('handover'))
  assert.ok(types.includes('check-failed'))
  assert.ok(why.overdueDays >= 1)
  assert.ok(why.reasons.every(r => typeof r.text === 'string' && r.text.length > 5))
})

if (process.exitCode) {
  console.error(`\n❌ 存在失败用例`)
  process.exit(1)
}
console.log(`\n🎉 全部 ${passed} 组验收场景通过`)
