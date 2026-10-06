// @ts-check
import { reactive, computed, watch } from 'vue'
// 后台任务/签收后重跑 buildManifest 即更新本文件；VitePress 构建时静态内联
// @ts-ignore
import manifestData from '../../review-data/manifest.json'

/** 路径 -> 复审条目（兼容尾部 /index 与 cleanUrls） */
function normalizePath(p) {
  if (!p) return ''
  let s = p.replace(/\.html$/, '').replace(/\/index$/, '/')
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s || '/'
}

const byPath = new Map()
for (const e of manifestData.entries) byPath.set(normalizePath(e.path), e)

const STORAGE_KEY = 'review-maintainer-mode'

const state = reactive({
  routePath: '',
  maintainer: typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1'
})

if (typeof window !== 'undefined') {
  // 路由切换后重新定位条目
  const update = () => { state.routePath = normalizePath(window.location.pathname.replace(/^\/docs/, '')) }
  update()
  window.addEventListener('popstate', update)
}

watch(() => state.maintainer, v => {
  if (typeof localStorage === 'undefined') return
  v ? localStorage.setItem(STORAGE_KEY, '1') : localStorage.removeItem(STORAGE_KEY)
})

export const LEVEL_META = {
  verified:           { label: '已复审', tone: 'ok',      tip: '本页声明范围已全部核对通过' },
  'due-for-review':   { label: '到期需核实', tone: 'warn', tip: '复审周期已到，以下信息需核实；历史内容仍可正常阅读' },
  'needs-review':     { label: '待复审', tone: 'muted',    tip: '本页尚未完成复审' },
  'in-progress':      { label: '复审中', tone: 'info',     tip: '已核对部分内容，尚未覆盖声明范围' },
  'needs-recheck':    { label: '信息需核实', tone: 'warn', tip: '相关内容发生关键变化，关联项待重新核对；页面内容不会被自动撤下' },
  'partial-failed':   { label: '部分未通过', tone: 'danger', tip: '存在检查未通过项，公开日期暂不可用' },
  overdue:            { label: '复审超期', tone: 'danger', tip: '复审任务已超期，请尽快处理' },
  'overdue-unassigned': { label: '超期·无负责人', tone: 'danger', tip: '任务超期且没有继任负责人，需先指派' }
}

export function useReview() {
  const entry = computed(() => byPath.get(normalizePath(state.routePath)) || null)
  return {
    zone: manifestData.zone,
    generatedAt: manifestData.generatedAt,
    generatedAtLabel: manifestData.generatedAtLabel,
    entries: manifestData.entries,
    state,
    entry,
    levelMeta: (level) => LEVEL_META[level] || { label: level, tone: 'muted', tip: '' },
    toggleMaintainer() { state.maintainer = !state.maintainer },
    syncRoute(path) { if (path) state.routePath = normalizePath(path) }
  }
}
