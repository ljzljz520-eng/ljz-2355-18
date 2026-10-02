#!/usr/bin/env node
// 生成演示复审数据并导出站点消费的公开清单：
//   node server/cli/seed.js [--out docs/public/review-manifest.json]
//
// 演示覆盖的验收场景：
//  - /guide/installation 已完成签收（正常基线）
//  - /guide/quickstart  原负责人离职 -> 转派给继任者（保留签收历史）
//  - /components/button 依赖（示例/图）变更，部分检查失败，且签收时页面又更新 -> 重验
//  - 一篇“无继任负责人”文档（离职未指派）
//  - 一篇临期文档（用于黄色提示与原因面板）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryRepo } from '../store/memory.js'
import { ReviewEngine } from '../core/engine.js'
import { addZonedDays, formatZoned, zonedParts, zonedDayStart } from '../core/time.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ZONE = 'Asia/Shanghai'

// 确定性时钟：以“今天 10:00（站点时区）”为锚点，保证演示可复现
function anchoredClock() {
  const now = new Date()
  const p = zonedParts(now, ZONE)
  return zonedDayStart(p.year, p.month, p.day, ZONE).getTime() + 10 * 3600_000
}

// 稳定 hash（演示用；生产由 git blob / 内容 SHA 提供）
function h(s) {
  let v = 5381
  for (let i = 0; i < s.length; i++) v = ((v << 5) + v + s.charCodeAt(i)) >>> 0
  return 'h' + v.toString(16)
}

const docManifest = (route) => ({
  body: [{ path: `${route}.md`, hash: h(`body:${route}:v1`) }],
  examples: route === '/components/button'
    ? [{ path: 'examples/button/basic.vue', hash: h('ex:basic:v1') },
       { path: 'examples/button/link.vue', hash: h('ex:link:v1') }]
    : [],
  figures: route === '/components/button'
    ? [{ path: 'images/button-anatomy.png', hash: h('img:anatomy:v1'), declared: true }]
    : [],
  tables: [{ path: `${route}.md#api`, hash: h(`table:${route}:v1`) }],
  configs: []
})

async function main() {
  const outArg = process.argv.find((a) => a.startsWith('--out='))
  const outPath = outArg
    ? outArg.slice(6)
    : path.resolve(__dirname, '../../docs/public/review-manifest.json')

  const repo = new MemoryRepo()
  const clock = anchoredClock
  const eng = new ReviewEngine({ repo, zone: ZONE, clock })

  // ---- 组织
  await eng.addUser({ id: 'u_alice', name: 'Alice（平台组）' })
  await eng.addUser({ id: 'u_bob', name: 'Bob（组件组）' })
  await eng.addUser({ id: 'u_carol', name: 'Carol（继任）' })
  await eng.addUser({ id: 'u_dave', name: 'Dave（已离职）', active: false })
  await eng.addGroup({ id: 'g_docs', name: '文档小组', memberIds: ['u_alice', 'u_carol'] })
  await eng.addGroup({ id: 'g_components', name: '组件小组', memberIds: ['u_bob'] })

  await eng.addDoc({
    id: 'doc_install', route: '/guide/installation', title: '安装指南',
    ownerId: 'u_alice', groupId: 'g_docs', cycleDays: 90
  })
  await eng.addDoc({
    id: 'doc_quick', route: '/guide/quickstart', title: '快速开始',
    ownerId: 'u_dave', groupId: 'g_docs', cycleDays: 90
  })
  await eng.addDoc({
    id: 'doc_button', route: '/components/button', title: 'Button 按钮',
    ownerId: 'u_bob', groupId: 'g_components', cycleDays: 90
  })
  await eng.addDoc({
    id: 'doc_orphan', route: '/guide/orphan', title: '孤儿文档（无继任示例）',
    ownerId: 'u_dave', groupId: 'g_docs', cycleDays: 60
  })
  await eng.addDoc({
    id: 'doc_due', route: '/guide/stale-page', title: '临期文档（黄色提示示例）',
    ownerId: 'u_alice', groupId: 'g_docs', cycleDays: 90
  })

  await eng.publishRelease({ id: 'rel_2026_09', name: '2026.09 发布版' })

  // ---- 固定周期扫描（首次）
  await eng.scanFixed('rel_2026_09', {
    doc_install: docManifest('/guide/installation'),
    doc_quick: docManifest('/guide/quickstart'),
    doc_button: docManifest('/components/button'),
    doc_orphan: docManifest('/guide/orphan'),
    doc_due: docManifest('/guide/stale-page')
  })

  const taskOf = async (docId) =>
    repo.find('tasks', (t) => t.docId === docId && t.releaseId === 'rel_2026_09')

  // ---- 安装指南：全部检查并签收（正常基线）
  {
    const t = await taskOf('doc_install')
    const items = await repo.list('items', (i) => i.taskId === t.id)
    for (const it of items) {
      await eng.recordCheck(t.id, it.itemKey, {
        result: 'passed', by: 'u_alice',
        evidence: [{ kind: 'note', ref: '对照官网逐项核对', sha256: h(`ev:${it.itemKey}`) }]
      })
    }
    await eng.signoff(t.id, { by: 'u_alice', note: '发布版前全量复审通过' })
  }

  // ---- 发布新版：所有文档进入新一轮复审（旧版未完成任务自动 superseded）
  // 快速开始先由 Dave 签收上一版（签收历史要保留）
  {
    const t = await taskOf('doc_quick')
    const items = await repo.list('items', (i) => i.taskId === t.id)
    for (const it of items) {
      await eng.recordCheck(t.id, it.itemKey, { result: 'passed', by: 'u_dave' })
    }
    await eng.signoff(t.id, { by: 'u_dave', note: '快速开始已复审' })
  }

  await eng.publishRelease({ id: 'rel_2026_10', name: '2026.10 发布版' })
  await eng.scanFixed('rel_2026_10', {
    doc_install: docManifest('/guide/installation'),
    doc_quick: docManifest('/guide/quickstart'),
    doc_button: docManifest('/components/button'),
    doc_orphan: docManifest('/guide/orphan'),
    doc_due: docManifest('/guide/stale-page')
  })

  // ---- 快速开始：Dave 离职，Carol 继任（历史签收者仍是 Dave，不被覆盖）
  {
    await eng.handover('doc_quick', { toUserId: 'u_carol', by: 'u_alice', reason: 'Dave 离职' })
  }

  // ---- 孤儿文档：Dave 离职且无继任（任务保持打开，owner_missing），且已超期
  {
    await eng.handover('doc_orphan', { toUserId: null, by: 'u_alice', reason: 'Dave 离职，暂无人接手' })
    const t = await repo.find('tasks', (x) => x.docId === 'doc_orphan' && x.status === 'open')
    const due = addZonedDays(new Date(clock()), -1, ZONE).getTime()
    await repo.update('tasks', t.id, { dueDate: due })
  }

  // ---- Button：依赖变更触发 -> 与固定任务合并；部分检查失败；签收时页面又更新
  {
    const t = await repo.find('tasks', (x) => x.docId === 'doc_button' && x.releaseId === 'rel_2026_10')

    // 正文未变，示例 basic.vue 更新 + 一张图更新：仅相关项待重验
    await eng.triggerDependencyChange('rel_2026_10', [
      { docId: 'doc_button', kind: 'example', path: 'examples/button/basic.vue', hash: h('ex:basic:v2') },
      { docId: 'doc_button', kind: 'figure', path: 'images/button-anatomy.png', hash: h('img:anatomy:v2') }
    ])
    // 重复投递同样的变更 -> 幂等，不产生新任务/新触发
    await eng.triggerDependencyChange('rel_2026_10', [
      { docId: 'doc_button', kind: 'example', path: 'examples/button/basic.vue', hash: h('ex:basic:v2') }
    ])

    const items = await repo.list('items', (i) => i.taskId === t.id)
    // 重检时携带 reviewer 在页面上实际看到的版本 hash
    const observed = {
      'example:examples/button/basic.vue': h('ex:basic:v2'),
      'figure:images/button-anatomy.png': h('img:anatomy:v2')
    }
    for (const it of items) {
      if (it.itemKey === 'figure:images/button-anatomy.png') {
        await eng.recordCheck(t.id, it.itemKey, {
          result: 'failed', by: 'u_bob', note: '图中尺寸标注与实现不符',
          observedHash: observed[it.itemKey]
        })
      } else {
        await eng.recordCheck(t.id, it.itemKey, {
          result: 'passed', by: 'u_bob',
          observedHash: observed[it.itemKey]
        })
      }
    }
    // 部分失败时签收应被拒绝（ITEMS_FAILED）；随后示例又更新（签收时页面更新）-> 相关项重置为待重验
    await eng.triggerDependencyChange('rel_2026_10', [
      { docId: 'doc_button', kind: 'example', path: 'examples/button/basic.vue', hash: h('ex:basic:v3') }
    ])
  }

  // ---- 临期文档：把到期日改到 2 天后（用于黄色提示 + 原因面板）
  {
    const t = await repo.find('tasks', (x) => x.docId === 'doc_due' && x.status === 'open')
    const due = addZonedDays(new Date(clock()), 2, ZONE).getTime()
    await repo.update('tasks', t.id, { dueDate: due })
  }

  // ---- 提醒（跑两次：验证重跑幂等）
  const reminders1 = await eng.runReminders()
  const reminders2 = await eng.runReminders()

  const manifest = await eng.buildManifest({ generatedAt: clock() })
  manifest.demo = {
    reminder: {
      firstRun: { created: reminders1.created.length, rerun: reminders1.rerun.length },
      secondRun: { created: reminders2.created.length, rerun: reminders2.rerun.length },
      overdueCount: reminders2.overdueCount
    },
    note: '演示数据由 server/cli/seed.js 生成，时间锚定当天 10:00（Asia/Shanghai）'
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const statusLine = manifest.docs.map((d) => `${d.route.padEnd(22)} ${d.status}`).join('\n  ')
  console.log(`[seed] zone=${ZONE} now=${formatZoned(new Date(clock()), ZONE, true)}`)
  console.log(`[seed] wrote ${path.relative(process.cwd(), outPath)}`)
  console.log('  ' + statusLine)
  console.log(`[seed] reminders: 1st created=${reminders1.created.length} rerun=${reminders1.rerun.length}; ` +
    `2nd created=${reminders2.created.length} rerun=${reminders2.rerun.length}; overdue=${reminders2.overdueCount}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
