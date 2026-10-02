import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, ReviewError } from '../src/engine.js'
import { periodBucket, formatInTz, plusDays } from '../src/time.js'

// ---- 夹具：一个标准页面，声明范围 examples/** + api/**，两个审阅项 ----
function fixture() {
  let now = Date.parse('2026-10-02T02:00:00Z')
  const engine = createEngine(() => now)
  engine.addMember({ id: 'alice', name: 'Alice 张' })
  engine.addMember({ id: 'bob', name: 'Bob 李' })
  engine.addMember({ id: 'carol', name: 'Carol 王' })
  const page = engine.registerPage({
    path: '/components/button',
    title: 'Button 按钮',
    declaredScope: ['examples/**', 'api/**'],
    owner: 'alice',
    hash: 'h1'
  })
  engine.configureReview(page.id, { tz: 'Asia/Shanghai', periodDays: 90 })
  const ex = engine.addItem(page.id, { node: 'examples/button/basic.vue', title: '基础示例' })
  const api = engine.addItem(page.id, { node: 'api/button', title: 'Button API 表' })
  const advance = (ms) => { now += ms }
  const setNow = (iso) => { now = Date.parse(iso) }
  return { engine, page, ex, api, now: () => now, advance, setNow }
}

// 随发布版生成任务并建立检查、签收
function releaseAndVerify(engine, pageId, version = 'v2.1.0', result = 'pass', by = 'alice') {
  const { tasks } = engine.publishRelease({
    version,
    pages: ['/components/button']
  })
  const task = tasks.find((t) => t.status === 'open')
  engine.recordCheck({ taskId: task.id, itemNode: 'examples/button/basic.vue', result, by })
  engine.recordCheck({ taskId: task.id, itemNode: 'api/button', result, by })
  return task
}

// ---------------------------------------------------------------- 1. 发布版任务
test('后台按发布版生成维护任务，重复发布同版本幂等', () => {
  const { engine, page } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const r1 = engine.publishRelease({ version: 'v2.1.0', pages: ['/components/button'] })
  assert.equal(r1.tasks.length, 1)
  const r2 = engine.publishRelease({ version: 'v2.1.0', pages: ['/components/button'] })
  assert.equal(r2.tasks.length, 0, '同版本重跑不再产生任务')
  assert.equal(engine._allTasks().filter((t) => t.idemKey === 'release:v2.1.0' && t.pageId === page.id).length, 1)
})

// ----------------------------------------------------- 2. 周期 vs 依赖：合并+幂等
test('固定周期扫描与依赖变更触发合并为一条待办，重复触发幂等', () => {
  const { engine, page } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const cycles1 = engine.scanCycles({ pagePaths: ['/components/button'] })
  const cycles2 = engine.scanCycles({ pagePaths: ['/components/button'] })
  assert.equal(cycles1[0].id, cycles2[0].id, '周期扫描重跑命中同一任务')

  // 依赖发版：触发 dependency 任务，应与打开的周期任务合并
  const deps = engine.dependencyChanged({
    depId: 'vue', depVersion: '3.5.28',
    affected: [{ pagePath: '/components/button' }]
  })
  const deps2 = engine.dependencyChanged({
    depId: 'vue', depVersion: '3.5.28',
    affected: [{ pagePath: '/components/button' }]
  })
  assert.equal(deps[0].id, deps2[0].id, '同依赖版本重复触发幂等')

  const open = engine._tasksOf(page.id)
  assert.equal(open.length, 1, '两类任务合并后只剩一条打开待办')
  assert.equal(open[0].type, 'merged', '合并任务类型标记为 merged')
  assert.equal(engine._allTasks().length, 2, '被合并的另一条标记 superseded 而非删除')
})

// ------------------------------------------------------- 3. 时区切换（站点 tz）
test('周期桶按站点时区折算，页脚日期可在时区之间切换', () => {
  const instant = Date.parse('2026-10-01T16:30:00Z') // = 上海 10-02 00:30 / UTC 10-01
  const sh = periodBucket(instant, 90, 'Asia/Shanghai')
  const utc = periodBucket(instant, 90, 'UTC')
  assert.notEqual(sh, utc, '不同时区的周期桶起点不同')
  // 上海已是 10-02，归入本地 09-04 起算的 90 天桶（桶起点 UTC 时刻为前一日 16:00）
  assert.equal(formatInTz(sh, 'Asia/Shanghai').slice(0, 10), '2026-09-04')
  assert.equal(new Date(sh).toISOString(), '2026-09-03T16:00:00.000Z')
  // UTC 仍在 10-01 当天的桶；其 UTC 桶起点晚 8 小时
  assert.equal(formatInTz(utc, 'UTC').slice(0, 10), '2026-09-04')
  assert.equal(new Date(utc).toISOString(), '2026-09-04T00:00:00.000Z')

  const { engine } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const task = releaseAndVerify(engine)
  engine.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1' })
  const fSh = engine.publicFooter('/components/button', { tz: 'Asia/Shanghai' })
  const fUtc = engine.publicFooter('/components/button', { tz: 'UTC' })
  assert.match(fSh.verifiedDate.display, /10:00 \(Asia\/Shanghai\)/)
  assert.match(fUtc.verifiedDate.display, /02:00 \(UTC\)/)
  assert.equal(fSh.verifiedDate.at, fUtc.verifiedDate.at, '底层时刻不变，仅展示时区不同')
})

// ----------------------------------------------------- 4. 无继任负责人
test('负责人离职且无继任：待办转 blocked，不可签收，不丢失', () => {
  const { engine, page } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const task = releaseAndVerify(engine, 'v2.1.0', 'pass', 'alice')
  engine.deactivateMember('alice')
  const moved = engine.handoverPages({ pageIds: [page.id], from: 'alice', to: null, reason: 'leave', by: 'hr' })
  assert.equal(moved.length, 1)
  assert.equal(task.status, 'blocked_no_owner')
  assert.equal(task.currentOwner, null)
  assert.throws(
    () => engine.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1' }),
    /cannot sign off/
  )
  // 指定继任后恢复
  engine.handoverPages({ pageIds: [page.id], from: null, to: 'bob', reason: 'team_adjust', by: 'hr' })
  assert.equal(task.status, 'open')
  assert.equal(task.currentOwner, 'bob')
  engine.signoff({ taskId: task.id, by: 'bob', expectedHash: 'h1' })
  assert.equal(task.status, 'done')
})

// ----------------------------------------------- 5. 转派不覆盖曾签收者
test('责任交接转派待办，但历史签收者保持不变', () => {
  const { engine, page } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const task = releaseAndVerify(engine)
  engine.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1' })
  assert.equal(task.status, 'done')
  // 新一轮发布后离职转派
  const { tasks } = engine.publishRelease({ version: 'v2.2.0', pages: ['/components/button'] })
  engine.deactivateMember('alice')
  engine.handoverPages({ pageIds: [page.id], from: 'alice', to: 'bob', reason: 'leave', by: 'hr' })
  const diag = engine.diagnostics(page.id)
  assert.equal(diag.owner, 'bob', '当前负责人变为继任者')
  const historySigners = diag.history.map((h) => h.signer)
  assert.ok(historySigners.includes('alice'), '历史签收者 alice 不被覆盖')
  assert.deepEqual(diag.openTasks[0].assignmentTrail.map((t) => [t.from, t.to, t.reason]),
    [['alice', 'bob', 'leave']])
})

// ----------------------------------------- 6. 复审到期：只提示，不撤历史内容
test('复审到期只标记 needs_verification，历史内容保持可读', () => {
  const { engine, page, setNow } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const task = releaseAndVerify(engine)
  engine.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1' })

  setNow('2026-10-02T02:00:00Z')
  assert.equal(engine.evaluatePage(page.id).status, 'verified')
  setNow('2027-02-01T00:00:00Z') // 超过 90 天周期
  const ev = engine.evaluatePage(page.id)
  assert.equal(ev.status, 'needs_verification')
  assert.equal(ev.readable, true, '到期不撤历史可读内容')
  assert.ok(ev.latestFullSignoff, '历史签收事实仍保留')
  const footer = engine.publicFooter('/components/button')
  assert.equal(footer.status, 'needs_verification')
  assert.match(footer.notice, /信息需要核实/)
  assert.equal(footer.fullScopeVerified, false)
})

// ----------------------------------------- 7. 抽查一处 ≠ 整篇复审
test('只检查一处示例不能签收整篇：存在未验证项即拒绝', () => {
  const { engine } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const { tasks } = engine.publishRelease({ version: 'v2.1.0', pages: ['/components/button'] })
  const task = tasks[0]
  engine.recordCheck({ taskId: task.id, itemNode: 'examples/button/basic.vue', result: 'pass', by: 'alice' })
  assert.throws(
    () => engine.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1' }),
    /pending verification on current revision/
  )
})

// ----------------------------------------- 8. 覆盖图必须满足声明范围
test('审阅项覆盖图不满足声明范围时拒绝签收', () => {
  let now = Date.parse('2026-10-02T02:00:00Z')
  const engine = createEngine(() => now)
  engine.addMember({ id: 'alice', name: 'A' })
  const page = engine.registerPage({
    path: '/guide/quickstart', title: '快速开始', owner: 'alice', hash: 'q1',
    declaredScope: ['guide/**', 'screenshots/**'] // 声明含截图，但没有对应审阅项
  })
  engine.addItem(page.id, { node: 'guide/quickstart.md', title: '正文' })
  engine.contentChanged('/guide/quickstart', { hash: 'q1', changedNodes: ['guide/quickstart.md'] })
  const { tasks } = engine.publishRelease({ version: 'v1', pages: ['/guide/quickstart'] })
  engine.recordCheck({ taskId: tasks[0].id, itemNode: 'guide/quickstart.md', result: 'pass', by: 'alice' })
  assert.throws(
    () => engine.signoff({ taskId: tasks[0].id, by: 'alice', expectedHash: 'q1' }),
    /declared scope not covered/
  )
})

// ----------------------------------------- 9. 正文关键变化 → 相关项待重验
test('正文关键变化使相关审阅项升版本，旧结论作废需重验', () => {
  const { engine, page } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const task = releaseAndVerify(engine, 'v2.1.0')
  engine.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1' })

  // 只改了示例文件：仅 examples 项命中
  const res = engine.contentChanged('/components/button', {
    hash: 'h2', changedNodes: ['examples/button/basic.vue']
  })
  assert.deepEqual(res.touched.map((t) => t.node), ['examples/button/basic.vue'])
  assert.equal(res.touched[0].bumped, true)
  const ev = engine.evaluatePage(page.id)
  assert.equal(ev.staleByContent, true)
  assert.equal(ev.status, 'needs_verification', '正文变化后需要重新核实')

  // 新一轮任务中，旧检查不再算数（新版本无结论），只检查被改的一项也不够
  engine.publishRelease({ version: 'v2.3.0', pages: ['/components/button'] })
  const open = engine._tasksOf(page.id)[0]
  engine.recordCheck({ taskId: open.id, itemNode: 'examples/button/basic.vue', result: 'pass', by: 'alice' })
  engine.recordCheck({ taskId: open.id, itemNode: 'api/button', result: 'pass', by: 'alice' })
  engine.signoff({ taskId: open.id, by: 'alice', expectedHash: 'h2' })
  assert.equal(open.status, 'done')
})

// ----------------------------------------- 10. 签收时页面更新
test('签收过程中页面被更新：拒绝签收，要求先重验', () => {
  const { engine } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const task = releaseAndVerify(engine)
  // 校验中途正文变化
  engine.contentChanged('/components/button', { hash: 'h1x', changedNodes: [] })
  assert.throws(
    () => engine.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1' }),
    /page changed during review/
  )
})

// ----------------------------------------- 11. 部分检查失败 → partial
test('部分检查失败只允许 partial 签收，公开日期反映真实完成范围', () => {
  const { engine, page } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const { tasks } = engine.publishRelease({ version: 'v2.1.0', pages: ['/components/button'] })
  const task = tasks[0]
  engine.recordCheck({ taskId: task.id, itemNode: 'examples/button/basic.vue', result: 'pass', by: 'alice' })
  engine.recordCheck({ taskId: task.id, itemNode: 'api/button', result: 'fail', by: 'alice', note: '属性表缺少 loading 行' })
  const r = engine.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1', comment: '示例通过，API 待整改' })
  assert.equal(r.signoff.outcome, 'partial')
  assert.equal(r.passed, 1)
  assert.equal(r.failed, 1)
  assert.equal(task.status, 'open', 'partial 不关闭任务，失败项需整改重验')

  const footer = engine.publicFooter('/components/button')
  assert.deepEqual(footer.verificationScope, ['examples/button/basic.vue'], '公开范围只含真实通过项')
  assert.deepEqual(footer.failedScope.map((f) => f.node), ['api/button'])
  assert.equal(footer.fullScopeVerified, false)
  assert.ok(footer.verifiedDate, '仍展示完成部分的真实日期，而不是冒充整篇完成')

  // PG 证据：证据与签收 append-only（此处由 store 冻结模拟）
  const sign = engine.store.signoffs.at(-1)
  assert.throws(() => { sign.signer = 'bob' }, /object is not extensible|Cannot assign/)
})

// ----------------------------------------- 12. 提醒任务重跑幂等
test('提醒任务可安全重跑：每个任务每类提醒只发一次', () => {
  const { engine, setNow } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const r = engine.publishRelease({ version: 'v2.1.0', pages: ['/components/button'], at: Date.parse('2026-10-02T02:00:00Z') })
  const task = r.tasks[0]
  setNow('2026-10-05T02:00:00Z') // 仍在 7 天 due-soon 窗口？due=10-02 → 已超期
  const s1 = engine.runReminders()
  const s2 = engine.runReminders()
  const s3 = engine.runReminders()
  assert.equal(s1.length, 1)
  assert.equal(s1[0].kind, 'overdue')
  assert.equal(s2.length, 0)
  assert.equal(s3.length, 0)
  assert.equal(engine.remindersOf(task.id).length, 1)
})

// ----------------------------------------- 13. 维护者看到超期原因
test('维护者诊断不只给黄色标签，而是完整超期原因链路', () => {
  const { engine, page, setNow } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const { tasks } = engine.publishRelease({ version: 'v2.1.0', pages: ['/components/button'] })
  engine.recordCheck({ taskId: tasks[0].id, itemNode: 'examples/button/basic.vue', result: 'fail', by: 'alice', note: '示例报错' })
  engine.recordCheck({ taskId: tasks[0].id, itemNode: 'api/button', result: 'pass', by: 'alice' })
  engine.deactivateMember('alice')
  engine.handoverPages({ pageIds: [page.id], from: 'alice', to: null, reason: 'leave', by: 'hr' })
  setNow('2026-10-20T00:00:00Z')
  const diag = engine.diagnostics(page.id)
  assert.equal(diag.status, 'needs_verification')
  const text = diag.reasons.join(' | ')
  assert.match(text, /无继任负责人/)
  assert.match(text, /检查失败项/)
  assert.match(text, /超期/)
  assert.ok(diag.overdueDays > 0)
  // 待办明细里能看到哪个项卡住
  const stuck = diag.openTasks[0].items.find((i) => i.node === 'examples/button/basic.vue')
  assert.equal(stuck.pending, true)
  assert.equal(stuck.lastResult, 'fail')
})

// ----------------------------------------- 14. 小组调整批量转派
test('小组调整批量转派多页待办', () => {
  let now = Date.parse('2026-10-02T02:00:00Z')
  const engine = createEngine(() => now)
  engine.addMember({ id: 'alice', name: 'A' })
  engine.addMember({ id: 'carol', name: 'C' })
  const p1 = engine.registerPage({ path: '/a', title: 'A', owner: 'alice', hash: 'a1' })
  const p2 = engine.registerPage({ path: '/b', title: 'B', owner: 'alice', hash: 'b1' })
  engine.contentChanged('/a', { hash: 'a1', changedNodes: [] })
  engine.contentChanged('/b', { hash: 'b1', changedNodes: [] })
  engine.publishRelease({ version: 'v9', pages: ['/a', '/b'] })
  const moved = engine.handoverPages({ pageIds: [p1.id, p2.id], from: 'alice', to: 'carol', reason: 'team_adjust', by: 'pmo' })
  assert.equal(moved.length, 2)
  assert.equal(engine.currentOwner(p1.id), 'carol')
  assert.equal(engine.currentOwner(p2.id), 'carol')
})

// ----------------------------------------- 15. 检查记录重复写入幂等
test('同一审阅项同版本重复检查不产生重复记录（重跑安全）', () => {
  const { engine } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const { tasks } = engine.publishRelease({ version: 'v2.1.0', pages: ['/components/button'] })
  const a = engine.recordCheck({ taskId: tasks[0].id, itemNode: 'api/button', result: 'pass', by: 'alice' })
  const b = engine.recordCheck({ taskId: tasks[0].id, itemNode: 'api/button', result: 'pass', by: 'alice' })
  assert.equal(a.duplicated, false)
  assert.equal(b.duplicated, true)
  assert.equal(engine.store.checks.filter((c) => c.itemId === b.check.itemId).length, 1)
})

// ----------------------------------------- 16. 证据持久化 + 只追加
test('审阅证据随签收保存，签收/证据/交接只追加不可改', () => {
  const { engine, page } = fixture()
  engine.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })
  const task = releaseAndVerify(engine)
  const res = engine.signoff({
    taskId: task.id, by: 'alice', expectedHash: 'h1',
    evidence: [
      { kind: 'screenshot', uri: 'oss://review/button-ok.png', hash: 'sha256:aaa' },
      { kind: 'link', uri: 'https://ci.example.com/run/42' }
    ]
  })
  const ev = engine.store.evidences.filter((e) => e.signoffId === res.signoff.id)
  assert.equal(ev.length, 2)
  // append-only：签收、证据、交接冻结（对应 PG 触发器）
  assert.throws(() => { res.signoff.signer = 'carol' })
  assert.throws(() => { ev[0].uri = 'tampered' })
  const handover = engine.store.handovers[0]
  assert.throws(() => { handover.toOwner = 'carol' })
  // 证据行可独立查询到任务与页面（PG: JOIN review_signoff）
  assert.equal(ev[0].uploadedBy, 'alice')
  assert.equal(res.signoff.pageId, page.id)
})
