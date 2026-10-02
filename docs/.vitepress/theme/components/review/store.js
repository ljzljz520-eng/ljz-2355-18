// 复审数据 store（客户端）。
// - 从 /review-manifest.json 读取公开清单（构建时由 server/cli/seed.js 或真实后台导出）
// - 站点时区可在运行时切换（UTC/上海/柏林/洛杉矶），用于演示到期判定随时区变化
// - 到期/失鲜只提示“信息需核实”，不会撤掉任何正文可读内容

import { reactive, computed, readonly } from 'vue'

export const REVIEW_ZONES = ['UTC', 'Asia/Shanghai', 'Europe/Berlin', 'America/Los_Angeles']

const state = reactive({
  manifest: null,
  loading: false,
  error: null,
  zone: 'Asia/Shanghai',
  route: '',
  now: Date.now()
})

function zonedParts(date, zone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  })
  const p = {}
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour === 24 ? 0 : +p.hour, minute: +p.minute, second: +p.second
  }
}

function pad(n) { return String(n).padStart(2, '0') }

/** 按当前站点时区重新渲染日期（清单里的 dueDate 是绝对时间戳） */
export function fmtDate(ts, zone = state.zone, withTime = false) {
  if (ts == null) return ''
  const p = zonedParts(new Date(ts), zone)
  return withTime
    ? `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
    : `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

export function daysLeft(ts, zone = state.zone, now = state.now) {
  if (ts == null) return null
  const a = zonedParts(new Date(now), zone)
  const b = zonedParts(new Date(ts), zone)
  const today = Date.UTC(a.year, a.month - 1, a.day)
  const due = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((due - today) / 86400000)
}

export const i18n = {
  'zh-CN': {
    'review.label': '文档复审',
    'review.owner': '负责人',
    'review.scope': '校验范围',
    'review.due': '复审到期',
    'review.publicDate': '公开日期',
    'review.lastRelease': '发布版',
    'review.signoffHistory': '签收记录',
    'review.status.verified': '已复审',
    'review.status.in_review': '复审中',
    'review.status.due_soon': '即将到期',
    'review.status.overdue': '已超期',
    'review.status.partial_failed': '部分检查失败',
    'review.status.owner_missing': '无继任负责人',
    'review.stale': '清单生成后内容有更新，信息需核实（历史内容仍可阅读）',
    'review.zone': '站点时区',
    'review.reason.owner_missing': '负责人离职且无继任，待办无人接手',
    'review.reason.failed_items': '存在检查失败的审阅项',
    'review.reason.pending_items': '仍有审阅项未检查',
    'review.reason.content_changed_pending': '正文/依赖发生关键变化，相关项待重验',
    'review.reason.coverage_gap': '已检查但未覆盖声明范围',
    'review.reason.overdue_without_progress': '已超期且无检查进展',
    'review.reason.awaiting_review': '等待复审',
    'review.item.body': '正文',
    'review.item.example': '示例',
    'review.item.figure': '图',
    'review.item.table': '表格',
    'review.item.config': '配置',
    'review.whyOverdue': '为什么是这个状态',
    'review.itemsProgress': '审阅项进度',
    'review.verifiedScope': '实际完成范围',
    'review.daysLeft': '剩余 {n} 天',
    'review.daysOverdue': '已超期 {n} 天',
    'review.today': '今天到期'
  },
  en: {
    'review.label': 'Doc review',
    'review.owner': 'Owner',
    'review.scope': 'Verified scope',
    'review.due': 'Review due',
    'review.publicDate': 'Public date',
    'review.lastRelease': 'Release',
    'review.signoffHistory': 'Sign-off history',
    'review.status.verified': 'Verified',
    'review.status.in_review': 'In review',
    'review.status.due_soon': 'Due soon',
    'review.status.overdue': 'Overdue',
    'review.status.partial_failed': 'Some checks failed',
    'review.status.owner_missing': 'No successor owner',
    'review.stale': 'Content changed after this manifest was generated; verify before relying on it (historical content stays readable).',
    'review.zone': 'Site timezone',
    'review.reason.owner_missing': 'Owner left without a successor; work is unassigned',
    'review.reason.failed_items': 'One or more review items failed',
    'review.reason.pending_items': 'Some review items are not checked yet',
    'review.reason.content_changed_pending': 'Key content/dependency changed; affected items need re-verification',
    'review.reason.coverage_gap': 'Checks do not cover the declared scope',
    'review.reason.overdue_without_progress': 'Overdue with no check progress',
    'review.reason.awaiting_review': 'Awaiting review',
    'review.item.body': 'Body',
    'review.item.example': 'Example',
    'review.item.figure': 'Figure',
    'review.item.table': 'Table',
    'review.item.config': 'Config',
    'review.whyOverdue': 'Why this status',
    'review.itemsProgress': 'Item progress',
    'review.verifiedScope': 'Actual completed scope',
    'review.daysLeft': '{n} days left',
    'review.daysOverdue': '{n} days overdue',
    'review.today': 'Due today'
  }
}

let loadPromise = null
async function fetchManifest() {
  if (state.manifest || loadPromise) return loadPromise
  state.loading = true
  loadPromise = fetch('/review-manifest.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    })
    .then((data) => { state.manifest = data; state.error = null })
    .catch((e) => { state.error = e.message })
    .finally(() => { state.loading = false })
  return loadPromise
}

export function useReview(langRef) {
  fetchManifest()

  // 每分钟刷新一次“今天”，保证跨日/切换时区后状态会变
  if (!useReview._timer) {
    useReview._timer = setInterval(() => { state.now = Date.now() }, 60_000)
  }

  const t = (key) => {
    const lang = (langRef && langRef.value) || 'zh-CN'
    return (i18n[lang]?.[key]) || (i18n['zh-CN'][key]) || key
  }

  const scopeLabel = (s, lang) => {
    const map = {
      body: 'review.item.body', examples: 'review.item.example', figures: 'review.item.figure',
      tables: 'review.item.table', configs: 'review.item.config'
    }
    const key = map[s]
    const l = lang || (langRef && langRef.value) || 'zh-CN'
    return (i18n[l]?.[key]) || (i18n['zh-CN'][key]) || s
  }

  return {
    state: readonly(state),
    setZone(z) { state.zone = z },
    setRoute(r) { state.route = r },
    t,
    fmtDate,
    daysLeft,
    scopeLabel,
    entryByRoute(route) {
      if (!state.manifest) return null
      const docs = state.manifest.docs
      return docs.find((d) => d.route === route) ||
        docs.find((d) => route.endsWith(d.route + '.html')) ||
        docs.find((d) => d.route === route.replace(/\.html$/, '')) || null
    }
  }
}
