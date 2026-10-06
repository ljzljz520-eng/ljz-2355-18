<script setup>
import { ref, computed } from 'vue'
import { useReview, LEVEL_META } from '../composables/useReview.js'

const { entries, zone, state, toggleMaintainer, generatedAtLabel } = useReview()
const filter = ref('all')

const counts = computed(() => {
  const c = { total: entries.length, overdue: 0, unassigned: 0, unverified: 0, verified: 0 }
  for (const e of entries) {
    if (e.overdue) c.overdue++
    if (e.unassigned) c.unassigned++
    if (e.level === 'verified' || e.level === 'due-for-review') c.verified++
    else c.unverified++
  }
  return c
})

const rows = computed(() => {
  const list = entries.filter(e => {
    if (filter.value === 'overdue') return e.overdue
    if (filter.value === 'unassigned') return e.unassigned
    if (filter.value === 'unverified') return e.level !== 'verified' && e.level !== 'due-for-review'
    return true
  })
  const rank = { 'overdue-unassigned': 0, 'partial-failed': 1, 'needs-recheck': 2, overdue: 3, 'due-for-review': 4, 'in-progress': 5, 'needs-review': 6, verified: 7 }
  return [...list].sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9))
})

const fmt = (iso, withTime = false) => {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
  }).format(new Date(iso))
}
</script>

<template>
  <div class="rv-board">
    <div class="rv-board__head">
      <h2 id="复审管理面板">产品文档复审面板</h2>
      <div class="rv-board__toolbar">
        <button class="rv-mini-btn" :class="{ 'is-on': state.maintainer }" @click="toggleMaintainer">
          {{ state.maintainer ? '🛠 维护者视图：开' : '维护者视图：关' }}
        </button>
        <span class="rv-board__gen">清单生成：{{ generatedAtLabel }}（{{ zone }}）</span>
      </div>
    </div>

    <div class="rv-stat-row">
      <div class="rv-stat"><b>{{ counts.total }}</b><span>文档总数</span></div>
      <div class="rv-stat rv-stat--danger"><b>{{ counts.overdue }}</b><span>已超期</span></div>
      <div class="rv-stat rv-stat--danger"><b>{{ counts.unassigned }}</b><span>无负责人</span></div>
      <div class="rv-stat rv-stat--warn"><b>{{ counts.unverified }}</b><span>未完整复审</span></div>
      <div class="rv-stat rv-stat--ok"><b>{{ counts.verified }}</b><span>已完整核对</span></div>
    </div>

    <div class="rv-filters">
      <button v-for="f in [['all','全部'],['overdue','超期'],['unassigned','无负责人'],['unverified','未完整复审']]"
              :key="f[0]" class="rv-mini-btn" :class="{ 'is-on': filter === f[0] }"
              @click="filter = f[0]">{{ f[1] }}</button>
    </div>

    <table class="rv-table">
      <thead>
        <tr>
          <th>文档 / 版本</th><th>状态</th><th>负责人</th><th>校验范围</th>
          <th>公开日期</th><th>应于</th><th v-if="state.maintainer">为什么超期</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="e in rows" :key="e.docId">
          <td><a :href="e.path">{{ e.title }}</a><br><small>v{{ e.version }}</small></td>
          <td><span class="rv-badge" :class="`rv-badge--${LEVEL_META[e.level]?.tone || 'muted'}`">
            {{ LEVEL_META[e.level]?.label || e.level }}
          </span></td>
          <td>
            <template v-if="e.owner">{{ e.owner.name }}</template>
            <em v-else class="rv-none">无继任</em>
          </td>
          <td>
            <div class="rv-coverage">
              <div class="rv-coverage__bar">
                <i :style="{ width: (e.coverage.total ? e.coverage.passed / e.coverage.total * 100 : 0) + '%' }"></i>
              </div>
              <small>{{ e.coverage.passed }}/{{ e.coverage.total }}
                <span v-if="e.coverage.failed.length"> · {{ e.coverage.failed.length }} 项失败</span></small>
            </div>
          </td>
          <td>{{ fmt(e.publicDate) }}<br>
            <small v-if="e.lastPublicDate" title="历史完成范围保留">上次 {{ fmt(e.lastPublicDate) }}</small>
          </td>
          <td>{{ fmt(e.dueDate) }}</td>
          <td v-if="state.maintainer" class="rv-why-cell">
            <ul v-if="e.overdueReasons.length">
              <li v-for="(r, i) in e.overdueReasons" :key="i">{{ r.text }}</li>
            </ul>
            <span v-else class="rv-none">—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="rv-board__note">
      说明：复审到期仅提示「信息需核实」，不会自动撤下任何历史可读内容；公开日期只在声明范围全部核对通过时写入，
      且会随关键变化失效；检查一处示例不等于整篇已复审。
    </p>
  </div>
</template>

<style scoped>
.rv-board__head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
.rv-board__toolbar { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--vp-c-text-3); }
.rv-mini-btn {
  border: 1px solid var(--vp-c-divider); background: var(--vp-c-bg-soft);
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; color: var(--vp-c-text-2);
}
.rv-mini-btn.is-on { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.rv-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 16px 0; }
.rv-stat { padding: 12px 16px; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg-soft); }
.rv-stat b { display: block; font-size: 22px; }
.rv-stat span { font-size: 12px; color: var(--vp-c-text-3); }
.rv-stat--danger b { color: var(--vp-c-danger-1); }
.rv-stat--warn b { color: var(--vp-c-warning-1, #e6a23c); }
.rv-stat--ok b { color: var(--vp-c-green-1, #36ad6a); }
.rv-filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.rv-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rv-table th, .rv-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--vp-c-divider); vertical-align: top; }
.rv-table th { color: var(--vp-c-text-3); font-weight: 500; white-space: nowrap; }
.rv-none { color: var(--vp-c-danger-1); font-style: normal; font-size: 12px; }
.rv-coverage { min-width: 110px; }
.rv-coverage__bar { height: 6px; border-radius: 3px; background: var(--vp-c-divider); overflow: hidden; }
.rv-coverage__bar i { display: block; height: 100%; background: var(--vp-c-green-1, #36ad6a); }
.rv-why-cell ul { margin: 0; padding-left: 16px; }
.rv-why-cell li { margin: 2px 0; color: var(--vp-c-text-2); }
.rv-board__note { margin-top: 16px; font-size: 12px; color: var(--vp-c-text-3); }
</style>
