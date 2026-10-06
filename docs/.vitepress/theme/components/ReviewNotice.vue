<script setup>
import { computed } from 'vue'
import { useReview } from '../composables/useReview.js'

const props = defineProps({
  entry: { type: Object, default: null },
  meta: { type: Object, default: null },
  compact: { type: Boolean, default: false }
})
const { state, levelMeta } = useReview()
const e = computed(() => props.entry)
const m = computed(() => props.meta || (e.value ? levelMeta(e.value.level) : null))

const visible = computed(() => {
  if (!e.value || !m.value) return false
  // verified / 普通待复审不强提示；其余状态给提示条
  return !['verified', 'needs-review'].includes(e.value.level)
})

const pendingLabels = computed(() =>
  (e.value?.coverage.pending || []).map(p => ({
    label: p.label,
    why: p.revalidateReason === 'body-change' ? '正文关键变化'
       : p.revalidateReason === 'api-spec-change' ? '上游接口变更'
       : p.revalidateReason ? '依赖内容变更' : ''
  }))
)
const failedLabels = computed(() => (e.value?.coverage.failed || []).map(f => f.label))
</script>

<template>
  <div v-if="visible" class="rv-notice" :class="`rv-notice--${m.tone}`" role="status">
    <span class="rv-notice__icon">
      {{ m.tone === 'ok' ? '✅' : m.tone === 'danger' ? '⛔' : '⚠️' }}
    </span>
    <div class="rv-notice__body">
      <strong>{{ m.label }}</strong>
      <span class="rv-notice__tip">{{ m.tip }}</span>
      <ul v-if="pendingLabels.length" class="rv-notice__list">
        <li v-for="p in pendingLabels" :key="p.label">
          「{{ p.label }}」<em v-if="p.why">待重验（{{ p.why }}）</em>
        </li>
      </ul>
      <div v-if="failedLabels.length" class="rv-notice__list">
        未通过：{{ failedLabels.join('、') }}
      </div>
      <div v-if="compact" class="rv-notice__foot">
        到期只做核实提示，历史内容保持可读；公开日期以真实完成范围为准。
      </div>
      <div v-if="state.maintainer && e.unassigned" class="rv-notice__foot rv-notice__foot--hot">
        维护者：该任务当前没有负责人，请先在<a href="/review/board">复审面板</a>指派继任者。
      </div>
    </div>
  </div>
</template>

<style scoped>
.rv-notice {
  display: flex; gap: 10px; align-items: flex-start;
  margin: 16px 0 20px; padding: 12px 16px;
  border-radius: 8px; border: 1px solid transparent; font-size: 13.5px;
  line-height: 1.7;
}
.rv-notice--warn {
  background: rgba(230, 162, 60, .12); border-color: rgba(230, 162, 60, .4); color: var(--vp-c-text-1);
}
.rv-notice--danger {
  background: rgba(224, 76, 76, .1); border-color: rgba(224, 76, 76, .35);
}
.rv-notice--info { background: var(--vp-c-bg-soft); border-color: var(--vp-c-divider); }
.rv-notice__icon { font-size: 16px; line-height: 1.5; }
.rv-notice__tip { margin-left: 8px; color: var(--vp-c-text-2); }
.rv-notice__list { margin: 4px 0 0; padding-left: 18px; color: var(--vp-c-text-2); }
.rv-notice__list em { color: var(--vp-c-warning-1, var(--vp-c-text-1)); font-style: normal; }
.rv-notice__foot { margin-top: 4px; font-size: 12px; color: var(--vp-c-text-3); }
.rv-notice__foot--hot { color: var(--vp-c-danger-1); }
.rv-notice__foot a { color: inherit; text-decoration: underline; }
</style>
