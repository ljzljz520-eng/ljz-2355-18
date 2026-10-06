/**
 * 演示数据：跑一条完整的复审业务时间线，并生成 VitePress 静态清单。
 *   node review-system/demo.mjs
 * 产物：review-system/data/state.json（领域状态）、
 *       docs/.vitepress/review-data/manifest.json（前端页脚/提示/面板数据源）
 */
import { JsonRepo } from './src/repo-json.js'
import { ReviewService } from './src/ReviewService.js'
import { buildManifest, writeManifest } from './src/manifest.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const T = (s) => new Date(s)
let now = T('2026-09-01T01:00:00Z')

const stateFile = path.join(here, 'data/state.json')
fs.rmSync(stateFile, { force: true })
const repo = new JsonRepo(stateFile)
const svc = new ReviewService({ repo, zone: 'Asia/Shanghai', clock: () => now, dependencyGraceDays: 7 })

// 人员
svc.createUser({ id: 'u_chen', name: '陈默', group: 'g_content' })
svc.createUser({ id: 'u_lin', name: '林晓', group: 'g_content' })
svc.createUser({ id: 'u_zhou', name: '周岩', group: 'g_platform' })

// 文档（对应站点真实页面）
svc.registerDoc({ id: 'doc-install', path: '/guide/installation', title: '安装指南', ownerId: 'u_chen' })
svc.registerDoc({ id: 'doc-quickstart', path: '/guide/quickstart', title: '快速开始', ownerId: 'u_lin' })
svc.registerDoc({ id: 'doc-button', path: '/components/button', title: 'Button 按钮', ownerId: 'u_zhou' })

const installScope = [
  { id: 'install-pm', label: '包管理器安装命令' },
  { id: 'install-version', label: '版本要求说明' }
]
svc.publishRelease({
  docId: 'doc-install', version: '1.0', intervalDays: 30,
  blocks: [
    { id: 'sec-pm', title: '使用包管理器', content: 'npm install my-component-lib@1.0', dependsOn: ['install-pm'] },
    { id: 'sec-ver', title: '版本要求', content: 'Node >= 18', dependsOn: ['install-version'] }
  ],
  declaredScope: installScope
})

const quickScope = [
  { id: 'quick-steps', label: '上手步骤' },
  { id: 'quick-demo', label: '在线示例' },
  { id: 'quick-faq', label: '常见问题' }
]
svc.publishRelease({
  docId: 'doc-quickstart', version: '1.0', intervalDays: 30,
  blocks: [
    { id: 'steps', title: '步骤', content: 'step 1..4', dependsOn: ['quick-steps'] },
    { id: 'demo', title: '示例', content: '<BaseButton/>', dependsOn: ['quick-demo'] },
    { id: 'faq', title: 'FAQ', content: 'Q: peer deps', dependsOn: ['quick-faq'] }
  ],
  declaredScope: quickScope
})

const btnScope = [
  { id: 'btn-basic-demo', label: '基础示例截图' },
  { id: 'btn-props', label: 'Attributes 表' },
  { id: 'btn-events', label: '事件说明' }
]
svc.publishRelease({
  docId: 'doc-button', version: '1.0', intervalDays: 30,
  blocks: [
    { id: 'basic', title: '基础用法', content: 'type=default demo', dependsOn: ['btn-basic-demo'] },
    { id: 'api-table', title: 'Attributes', content: 'type:string:default', dependsOn: ['btn-props'] },
    { id: 'events', title: 'Events', content: 'click', dependsOn: ['btn-events'] }
  ],
  declaredScope: btnScope
})

// ---- 时间线 ----
// 9/3：安装指南完整签收（2/2），公开日期写入
now = T('2026-09-03T02:00:00Z')
svc.recordCheck({ releaseId: 'rel_doc_install_1_0', targetId: 'install-pm', status: 'passed', byUserId: 'u_chen', evidence: 'npm/yarn/pnpm 命令逐一执行通过' })
svc.recordCheck({ releaseId: 'rel_doc_install_1_0', targetId: 'install-version', status: 'passed', byUserId: 'u_chen', evidence: '核对 README 与 CI Node 版本一致' })

// 9/5：快速开始只核了示例（一处示例 ≠ 整篇），另有一项检查失败
now = T('2026-09-05T02:00:00Z')
svc.recordCheck({ releaseId: 'rel_doc_quickstart_1_0', targetId: 'quick-demo', status: 'passed', byUserId: 'u_lin', evidence: '仅核对示例可运行' })
svc.recordCheck({ releaseId: 'rel_doc_quickstart_1_0', targetId: 'quick-faq', status: 'failed', byUserId: 'u_lin', evidence: 'peer deps 答案与实际安装结果不符' })

// 9/8：Button 上游 API 变更（依赖触发，不发新版）→ events 项待重验
now = T('2026-09-08T03:00:00Z')
svc.triggerDependencyChange({ docId: 'doc-button', targetIds: ['btn-events'], reason: 'api-spec-change', changedRef: 'Button click 事件载荷变更' })

// 10/06（"今天"）：
//  - 安装指南：负责人陈默离职，无继任者，且周期复审已超期
//  - Button 负责人周岩在职：组调整 g_content 不应波及它，依赖触发的待办仍在周岩名下
now = T('2026-10-06T01:30:00Z')
svc.runCycleScan()
svc.handover({ type: 'user', subjectId: 'u_chen', toUserId: null, reason: 'owner-leave' })
svc.handover({ type: 'group', subjectId: 'g_content', toUserId: 'u_zhou', reason: 'group-adjust' })
svc.runReminders()

// 快速开始：失败项在 10/04 修复并重验通过，但仍有 quick-steps 未核 → 仍不完整
now = T('2026-10-04T02:00:00Z')
svc.recordCheck({ releaseId: 'rel_doc_quickstart_1_0', targetId: 'quick-faq', status: 'passed', byUserId: 'u_lin', evidence: '已按实际安装结果更新 FAQ' })
now = T('2026-10-06T01:30:00Z')

const manifest = buildManifest(svc)
const out = writeManifest(manifest, path.join(here, '..', 'docs/.vitepress/review-data/manifest.json'))
console.log('清单已生成:', out)
for (const e of manifest.entries) {
  console.log(`- ${e.title} (v${e.version}) [${e.level}] 覆盖率 ${e.coverage.passed}/${e.coverage.total}` +
    ` 公开日期=${e.publicDate ? e.publicDate.slice(0, 10) : '—'} 负责人=${e.owner?.name ?? '无'}`)
}
