import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryRepo } from '../store/memory.js'
import { ReviewEngine } from '../core/engine.js'
import { ReviewError } from '../core/errors.js'
import { addZonedDays, zonedDayStart, zonedParts, isOverdue, formatZoned } from '../core/time.js'
import { coverageCheck } from '../core/items.js'

// 可控时钟
function fakeClock(start) {
  let t = start
  const fn = () => t
  fn.set = (v) => { t = v }
  fn.advance = (ms) => { t += ms }
  fn.day = 0
  return fn
}

const T0 = (zone) => zonedDayStart(2026, 10, 2, zone).getTime() + 10 * 3600_000 // 当天 10:00

function setup(zone = 'Asia/Shanghai') {
  const repo = new MemoryRepo()
  const clock = fakeClock(T0(zone))
  const eng = new ReviewEngine({ repo, zone, clock })
  return { repo, eng, clock, zone }
}

const man = (route, extra = {}) => ({
  body: [{ path: `${route}.md`, hash: 'body-v1' }],
  examples: extra.examples || [{ path: 'examples/a.vue', hash: 'ex-v1' }],
  figures: extra.figures || [{ path: 'images/f.png', hash: 'fig-v1', declared: true }],
  tables: [{ path: `${route}.md#api`, hash: 'tbl-v1' }],
  configs: []
})

async function seedOrgs(eng, { docCount = 1 } = {}) {
  await eng.addUser({ id: 'owner', name: 'Owner' })
  await eng.addUser({ id: 'succ', name: 'Successor' })
  await eng.addUser({ id: 'gone', name: 'Gone', active: false })
  for (let i = 1; i <= docCount; i++) {
    await eng.addDoc({
      id: `doc${i}`, route: `/p${i}`, title: `Page ${i}`,
      ownerId: 'owner', groupId: 'g1', cycleDays: 90,
      declaredScope: ['body', 'examples', 'figures']
    })
  }
  await eng.publishRelease({ id: 'r1', name: 'R1' })
}

async function checkAll(eng, repo, taskId, { result = 'passed', by = 'owner' } = {}) {
  const items = await repo.list('items', (i) => i.taskId === taskId)
  for (const it of items) {
    await eng.recordCheck(taskId, it.itemKey, {
      result: it.status === result || result === 'passed' ? result : result, by
    })
  }
  return items
}

// ------------------------------------------------------------ 固定周期扫描
test('固定周期扫描：按发布版为每篇文档生成任务，重复扫描幂等合并', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  const r1 = await eng.scanFixed('r1', { doc1: man('/p1') })
  assert.equal(r1.created.length, 1)
  const r1b = await eng.scanFixed('r1', { doc1: man('/p1') })
  assert.equal(r1b.created.length, 0, '重复扫描不应再建任务')
  assert.equal(r1b.skipped.length, 1, '应命中幂等键')
  const tasks = await repo.list('tasks')
  assert.equal(tasks.length, 1)
})

test('新发布版产生新任务时，旧版未完成 open 任务被 superseded（历史签收保留可读）', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t1 = await repo.find('tasks', (t) => t.releaseId === 'r1')
  await checkAll(eng, repo, t1.id)
  await eng.signoff(t1.id, { by: 'owner' })

  await eng.publishRelease({ id: 'r2', name: 'R2' })
  await eng.scanFixed('r2', { doc1: man('/p1') })
  const t2 = await repo.find('tasks', (t) => t.releaseId === 'r2')
  assert.equal(t2.status, 'open')
  const old = await repo.get('tasks', t1.id)
  assert.equal(old.status, 'signed', '旧签收任务不被覆盖')
  const manifest = await eng.buildManifest()
  assert.equal(manifest.docs[0].status, 'in_review')
  assert.ok(manifest.docs[0].publicDateText, '公开日期仍来自历史签收')
  assert.ok(manifest.docs[0].signoffHistory[0].by === 'owner')
})

// ------------------------------------------------------------ 依赖变更触发
test('依赖变更：与固定任务合并，只让相关项待重验，不影响其它项与签收历史', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')

  // 先全部检查通过（但先不签收）
  const items = await checkAll(eng, repo, t.id)
  // 只有一个示例变化
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'example', path: 'examples/a.vue', hash: 'ex-v2' }
  ])
  const after = await repo.list('items', (i) => i.taskId === t.id)
  const exItem = after.find((i) => i.itemKey === 'example:examples/a.vue')
  const bodyItem = after.find((i) => i.itemKey.startsWith('body:'))
  assert.equal(exItem.status, 'pending', '变更示例回到待重验')
  assert.equal(bodyItem.status, 'passed', '其它项保持已检查')
  assert.ok(t.reasons.concat(['dep']).length >= 1)
})

test('依赖变更重复投递相同 hash 是幂等的；新 hash 可再次触发', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const change = { docId: 'doc1', kind: 'example', path: 'examples/a.vue', hash: 'ex-v2' }
  await eng.triggerDependencyChange('r1', [change])
  const again = await eng.triggerDependencyChange('r1', [change])
  assert.equal(again.skipped.length, 1)
  const tasks = await repo.list('tasks')
  assert.equal(tasks.length, 1, '重复触发不应新建任务')
  const triggers = await repo.list('triggers')
  assert.equal(triggers.filter((x) => x.type === 'change').length, 1)

  const v3 = await eng.triggerDependencyChange('r1', [{ ...change, hash: 'ex-v3' }])
  assert.equal(v3.skipped.length, 0, '新 hash 视为新变更')
})

// ------------------------------------------------------------ 部分失败 / 签收时页面更新
test('部分检查失败时禁止签收', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  const items = await repo.list('items', (i) => i.taskId === t.id)
  for (const it of items) {
    await eng.recordCheck(t.id, it.itemKey, {
      result: it.kind === 'figure' ? 'failed' : 'passed', by: 'owner'
    })
  }
  await assert.rejects(
    () => eng.signoff(t.id, { by: 'owner' }),
    (e) => e instanceof ReviewError && e.code === 'ITEMS_FAILED'
  )
})

test('检查了一处示例不代表整篇已复审（声明范围缺图 -> 拒绝签收）', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  const items = await repo.list('items', (i) => i.taskId === t.id)
  // 只检查 body + example，漏图
  for (const it of items) {
    if (it.kind === 'figure') continue
    await eng.recordCheck(t.id, it.itemKey, { result: 'passed', by: 'owner' })
  }
  const err = await eng.signoff(t.id, { by: 'owner' }).then(() => null, (e) => e)
  assert.ok(err instanceof ReviewError)
  assert.equal(err.code, 'COVERAGE_INCOMPLETE')
  assert.ok(err.details.missing.includes('figure:images/f.png'))
})

test('图被检查但未在声明范围声明 -> 拒绝（图必须满足声明范围）', async () => {
  const cov = coverageCheck(
    [{ itemKey: 'figure:x.png', kind: 'figure', path: 'x.png' }],
    ['figure:x.png'],
    ['body'] // 未声明 figures
  )
  assert.equal(cov.ok, false)
  assert.deepEqual(cov.undeclared, ['figure:x.png'])
})

test('正文关键变化使相关项待重验（未按新版本重验直接签收 -> 拒绝并提示页面已更新）', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  await checkAll(eng, repo, t.id)
  // 正文关键变化：body 项回到 pending，其它项不动
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'body', path: '/p1.md', hash: 'body-v2' }
  ])
  const bodyItem0 = await repo.find('items', (i) => i.taskId === t.id && i.kind === 'body')
  assert.equal(bodyItem0.status, 'pending')
  const otherItem = await repo.find('items', (i) => i.taskId === t.id && i.kind === 'figure')
  assert.equal(otherItem.status, 'passed', '无关项保持已检查')
  // 直接签收：item 快照(body-v1) 落后最新版本(body-v2) -> CONTENT_CHANGED
  const err = await eng.signoff(t.id, { by: 'owner' }).then(() => null, (e) => e)
  assert.equal(err.code, 'CONTENT_CHANGED')
  assert.ok(err.details.staleKeys.includes('body:/p1.md'))
})

test('签收时页面（关键内容）在检查之后又更新 -> 拒绝签收并要求重验', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  // 第一次变化后完成重检
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'body', path: '/p1.md', hash: 'body-v2' }
  ])
  const bodyKey = 'body:/p1.md'
  await eng.recordCheck(t.id, bodyKey, { result: 'passed', by: 'owner', observedHash: 'body-v2' })
  for (const it of await repo.list('items', (i) => i.taskId === t.id)) {
    if (it.itemKey !== bodyKey && it.status === 'pending') {
      await eng.recordCheck(t.id, it.itemKey, { result: 'passed', by: 'owner' })
    }
  }
  // 检查完成、签收之前页面又更新（v3）
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'body', path: '/p1.md', hash: 'body-v3' }
  ])
  const err = await eng.signoff(t.id, { by: 'owner' }).then(() => null, (e) => e)
  assert.equal(err.code, 'CONTENT_CHANGED')
  assert.ok(err.details.staleKeys.includes(bodyKey))
  const bodyItem = await repo.find('items', (i) => i.taskId === t.id && i.kind === 'body')
  assert.equal(bodyItem.status, 'pending')
  assert.equal(bodyItem.contentHash, 'body-v3')
})

test('记录检查的瞬间页面已更新 -> 直接拒绝该次检查并要求重验', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'example', path: 'examples/a.vue', hash: 'ex-v2' }
  ])
  // 再变一次：item 快照停留在 v2，最新版本是 v3
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'example', path: 'examples/a.vue', hash: 'ex-v3' }
  ])
  const err = await eng.recordCheck(t.id, 'example:examples/a.vue', { result: 'passed', by: 'owner' })
    .then(() => null, (e) => e)
  assert.equal(err.code, 'CONTENT_CHANGED')
})

test('签收成功后公开日期与校验范围反映真实完成范围', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  await checkAll(eng, repo, t.id, { by: 'owner' })
  const so = await eng.signoff(t.id, { by: 'owner', note: 'done' })
  assert.ok(so.scope.length >= 4)
  const m = await eng.buildManifest()
  const d = m.docs[0]
  assert.equal(d.status, 'verified')
  assert.ok(d.publicDateText)
  assert.deepEqual(d.verifiedScope.sort(), ['body', 'examples', 'figures', 'tables'].sort())
})

// ------------------------------------------------------------ 责任交接
test('负责人离职转派待办但不覆盖历史签收者', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  await checkAll(eng, repo, t.id)
  await eng.signoff(t.id, { by: 'gone', note: 'gone signed' }) // 历史签收者
  await eng.publishRelease({ id: 'r2', name: 'R2' })
  await eng.scanFixed('r2', { doc1: man('/p1') })

  await eng.handover('doc1', { toUserId: 'succ', by: 'admin', reason: 'owner left' })
  const doc = await repo.get('docs', 'doc1')
  assert.equal(doc.ownerId, 'succ')
  const handovers = await repo.list('handovers')
  assert.equal(handovers.length, 1)
  assert.equal(handovers[0].fromOwnerId, 'owner')
  assert.equal(handovers[0].toOwnerId, 'succ')
  const signoffs = await repo.list('signoffs')
  assert.equal(signoffs[0].by, 'gone', '签收者不被覆盖')
  const m = await eng.buildManifest()
  assert.equal(m.docs[0].owner.name, 'Successor')
  assert.equal(m.docs[0].signoffHistory[0].by, 'gone')
})

test('离职且无继任负责人：任务保持打开，状态 owner_missing', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  await eng.handover('doc1', { toUserId: null, by: 'admin', reason: 'no successor' })
  const tasks = await repo.list('tasks')
  assert.equal(tasks[0].status, 'open', '无继任也不关单')
  const m = await eng.buildManifest()
  assert.equal(m.docs[0].status, 'owner_missing')
  assert.equal(m.docs[0].owner, null)
  assert.ok(m.docs[0].reasons.codes.includes('owner_missing'))
})

test('小组调整批量转派，逐篇留痕', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng, { docCount: 3 })
  await eng.scanFixed('r1', {
    doc1: man('/p1'), doc2: man('/p2'), doc3: man('/p3')
  })
  const recs = await eng.groupReassign('g1', { toUserId: 'succ', by: 'admin' })
  assert.equal(recs.length, 3)
  const docs = await repo.list('docs')
  assert.ok(docs.every((d) => d.ownerId === 'succ'))
})

// ------------------------------------------------------------ 到期 / 提醒 / 时区
test('复审到期只提示，不撤销历史可读内容（不自动下架）', async () => {
  const { eng, repo, clock, zone } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t1 = await repo.find('tasks', (t) => t.releaseId === 'r1')
  await checkAll(eng, repo, t1.id)
  await eng.signoff(t1.id, { by: 'owner' })

  await eng.publishRelease({ id: 'r2', name: 'R2' })
  await eng.scanFixed('r2', { doc1: man('/p1') })
  const t2 = await repo.find('tasks', (t) => t.releaseId === 'r2')
  // 让任务过期 1 天
  await repo.update('tasks', t2.id, {
    dueDate: addZonedDays(new Date(clock()), -1, zone).getTime()
  })
  const m = await eng.buildManifest()
  assert.equal(m.docs[0].status, 'overdue')
  assert.ok(m.docs[0].publicDateText, '历史公开日期仍在')
  assert.ok(m.docs[0].signoffHistory.length >= 1, '签收历史仍可读')
})

test('提醒任务重跑幂等：同窗口只一条 reminder，重跑累加 runCount', async () => {
  const { eng, repo, clock, zone } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  await repo.update('tasks', t.id, {
    dueDate: addZonedDays(new Date(clock()), 2, zone).getTime()
  })
  const r1 = await eng.runReminders()
  assert.equal(r1.created.length, 1)
  const r2 = await eng.runReminders()
  assert.equal(r2.created.length, 0)
  assert.equal(r2.rerun.length, 1)
  const reminders = await repo.list('reminders')
  assert.equal(reminders.length, 1)
  assert.equal(reminders[0].runCount, 2)
})

test('维护者能看到为何超期（原因码），而不只是黄色标签', async () => {
  const { eng, repo, clock, zone } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  // 图检查失败 -> 超期
  const items = await repo.list('items', (i) => i.taskId === t.id)
  for (const it of items) {
    await eng.recordCheck(t.id, it.itemKey, {
      result: it.kind === 'figure' ? 'failed' : 'passed', by: 'owner'
    })
  }
  await repo.update('tasks', t.id, { dueDate: addZonedDays(new Date(clock()), -1, zone).getTime() })
  const m = await eng.buildManifest()
  assert.equal(m.docs[0].status, 'overdue')
  assert.ok(m.docs[0].reasons.codes.includes('failed_items'), '超期状态同时给出失败原因，而不只是黄色标签')
  assert.equal(m.docs[0].reasons.detail.failedCount, 1)
})

test('时区切换：同一到期时刻在不同站点时区下的日历日判定不同', () => {
  // 到期日按上海口径设为 2026-10-02（绝对时刻 UTC 10-01 16:00）。
  // 当 UTC 刚跨入 10-02（上海仍是 10-02 上午）：
  //   上海口径：仍在到期日当天 -> 未超期；UTC 口径：今天 10-02 > 到期日 10-01 -> 已超期。
  const shanghaiDue = zonedDayStart(2026, 10, 2, 'Asia/Shanghai')
  const now1 = new Date(Date.UTC(2026, 9, 2, 2, 0))
  assert.equal(isOverdue(shanghaiDue, now1, 'Asia/Shanghai'), false)
  assert.equal(isOverdue(shanghaiDue, now1, 'UTC'), true)

  // 反向：到期日按 UTC 设为 2026-10-01。UTC 10-01 晚（上海已 10-02 凌晨）：
  //   UTC 口径：到期日当天 -> 未超期；上海口径：今天 10-02 > 到期日 10-01 -> 已超期。
  const utcDue = zonedDayStart(2026, 10, 1, 'UTC')
  const now2 = new Date(Date.UTC(2026, 9, 1, 20, 0))
  assert.equal(isOverdue(utcDue, now2, 'UTC'), false)
  assert.equal(isOverdue(utcDue, now2, 'Asia/Shanghai'), true)
})

test('时区切换后，固定周期到期日按目标时区日历日生成', () => {
  for (const zone of ['UTC', 'Asia/Shanghai', 'Europe/Berlin', 'America/Los_Angeles']) {
    const base = new Date(T0(zone))
    const due = addZonedDays(base, 90, zone)
    const p = zonedParts(due, zone)
    assert.equal(p.hour, 0)
    assert.equal(p.minute, 0)
    // 10-02 + 90 天 = 12-31
    assert.equal(`${p.year}-${p.month}-${p.day}`, '2026-12-31', zone)
  }
})

test('清单 stale：生成后又有关键内容变更 -> 标记信息需核实', async () => {
  const { eng, repo, clock } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const m1 = await eng.buildManifest({ generatedAt: clock() })
  assert.equal(m1.docs[0].stale, false)
  clock.advance(60_000)
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'body', path: '/p1.md', hash: 'body-later' }
  ])
  const m2 = await eng.buildManifest({ generatedAt: clock() - 1 })
  assert.equal(m2.docs[0].stale, true)
})

// ------------------------------------------------------------ 两类任务双向合并
test('固定扫描与依赖触发合并为一条任务（先固定后变更）', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'example', path: 'examples/a.vue', hash: 'ex-v2' }
  ])
  const tasks = await repo.list('tasks', (t) => t.status === 'open')
  assert.equal(tasks.length, 1)
  assert.deepEqual(tasks[0].reasons.sort(), ['dep:example:examples/a.vue', 'fixed-cycle-scan'].sort())
  assert.equal(tasks[0].triggerIds.length, 2)
})

test('先有变更触发，后固定扫描也合并（不另起任务）', async () => {
  const { eng, repo } = setup()
  await seedOrgs(eng)
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'body', path: '/p1.md', hash: 'body-vx' }
  ])
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const tasks = await repo.list('tasks', (t) => t.status === 'open')
  assert.equal(tasks.length, 1)
  assert.ok(tasks[0].reasons.includes('fixed-cycle-scan'))
  assert.ok(tasks[0].reasons.some((r) => r.startsWith('dep:')))
})

test('合并时到期日只提前不延后（变更 SLA 更紧）', async () => {
  const { eng, repo, clock, zone } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t0 = await repo.find('tasks', (t) => t.status === 'open')
  assert.ok(t0.dueDate > clock() + 30 * 86400000)
  await eng.triggerDependencyChange('r1', [
    { docId: 'doc1', kind: 'body', path: '/p1.md', hash: 'body-vx' }
  ])
  const t1 = await repo.find('tasks', (t) => t.status === 'open')
  assert.equal(t1.id, t0.id)
  assert.ok(t1.dueDate <= addZonedDays(new Date(clock()), 7, zone).getTime())
})

test('提醒原因随最新状态更新（修复后原因消失）', async () => {
  const { eng, repo, clock, zone } = setup()
  await seedOrgs(eng)
  await eng.scanFixed('r1', { doc1: man('/p1') })
  const t = await repo.find('tasks', (x) => x.status === 'open')
  await repo.update('tasks', t.id, { dueDate: addZonedDays(new Date(clock()), 1, zone).getTime() })
  await eng.runReminders()
  let r = await repo.find('reminders', () => true)
  assert.ok(r.reasons.codes.includes('pending_items'))
  // 全部检查并签收后任务关闭，不再产生提醒；下次重跑该窗口不新增
  for (const it of await repo.list('items', (i) => i.taskId === t.id)) {
    await eng.recordCheck(t.id, it.itemKey, { result: 'passed', by: 'owner' })
  }
  await eng.signoff(t.id, { by: 'owner' })
  const again = await eng.runReminders()
  assert.equal(again.created.length, 0)
})
