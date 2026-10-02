// 端到端演示：发布版任务 → 部分失败 → 责任人离职无继任 → 依赖触发合并 →
// 整改转派 → 签收 → 90 天后到期（只提示不撤内容）→ 时区切换查看页脚
import { createEngine } from '../src/engine.js'
import { formatInTz } from '../src/time.js'

let now = Date.parse('2026-10-02T02:00:00Z') // 北京 10:00
const eng = createEngine(() => now)
const line = (s) => console.log('\n— ' + s)

eng.addMember({ id: 'alice', name: 'Alice 张' })
eng.addMember({ id: 'bob', name: 'Bob 李' })
const page = eng.registerPage({
  path: '/components/button', title: 'Button 按钮',
  declaredScope: ['examples/**', 'api/**'], owner: 'alice', hash: 'h1'
})
eng.configureReview(page.id, { tz: 'Asia/Shanghai', periodDays: 90 })
eng.addItem(page.id, { node: 'examples/button/basic.vue', title: '基础示例' })
eng.addItem(page.id, { node: 'api/button', title: 'API 属性表' })
eng.contentChanged('/components/button', { hash: 'h1', changedNodes: ['examples/button/basic.vue', 'api/button'] })

line('① 随 v2.1.0 发布版生成维护任务（重跑幂等）')
console.log(eng.publishRelease({ version: 'v2.1.0', pages: ['/components/button'] }).tasks.length, '条（首次）')
console.log(eng.publishRelease({ version: 'v2.1.0', pages: ['/components/button'] }).tasks.length, '条（重跑）')

line('② Alice 校验：示例通过，API 表发现缺项（部分检查失败）')
const task = eng._tasksOf(page.id)[0]
eng.recordCheck({ taskId: task.id, itemNode: 'examples/button/basic.vue', result: 'pass', by: 'alice' })
eng.recordCheck({ taskId: task.id, itemNode: 'api/button', result: 'fail', by: 'alice', note: '属性表缺少 loading 行' })
const r = eng.signoff({ taskId: task.id, by: 'alice', expectedHash: 'h1', comment: '示例通过，API 待整改' })
console.log('签收结果：', r.signoff.outcome, `通过 ${r.passed} / 失败 ${r.failed}，任务状态仍为 ${task.status}`)

line('③ Alice 离职，暂无继任 → 待办阻塞但不丢失')
eng.deactivateMember('alice')
eng.handoverPages({ pageIds: [page.id], from: 'alice', to: null, reason: 'leave', by: 'hr' })
console.log('任务状态：', task.status, '| 当前负责人：', eng.currentOwner(page.id))

line('④ 依赖 vue@3.5.28 发版触发任务，与周期任务合并（幂等）')
eng.scanCycles({ pagePaths: ['/components/button'] })
const depArg = { depId: 'vue', depVersion: '3.5.28',
  affected: [{ pagePath: '/components/button', itemNodes: ['api/**'] }] }
eng.dependencyChanged(depArg)
eng.dependencyChanged(depArg) // 重跑幂等
console.log('打开待办数：', eng._tasksOf(page.id).length, '(两类已合并)')

line('⑤ Bob 接任并整改 API，完成全量签收（历史签收者仍为 Alice）')
eng.handoverPages({ pageIds: [page.id], from: null, to: 'bob', reason: 'team_adjust', by: 'hr' })
// 依赖只命中 api 节点：Bob 只需对升版后的 API 项重验
eng.recordCheck({ taskId: task.id, itemNode: 'api/button', result: 'pass', by: 'bob' })
eng.signoff({ taskId: task.id, by: 'bob', expectedHash: 'h1', comment: '已补 loading 行' })
console.log('任务状态：', task.status)

line('⑥ 公开页脚（上海 / UTC 切换）')
console.log('上海：', eng.publicFooter('/components/button', { tz: 'Asia/Shanghai' }).verifiedDate.display)
console.log('UTC ：', eng.publicFooter('/components/button', { tz: 'UTC' }).verifiedDate.display)

line('⑦ 91 天后：到期仅提示"信息需核实"，历史内容仍可读')
now = Date.parse('2027-01-05T02:00:00Z')
const f = eng.publicFooter('/components/button')
console.log('状态：', f.status, '| 提示：', f.notice)
console.log('历史完成范围仍可查：', f.verificationScope, '@', f.verifiedDate.display)

line('⑧ 维护者看到的不是黄色标签，而是原因')
for (const reason of eng.diagnostics(page.id).reasons) console.log('  -', reason)
