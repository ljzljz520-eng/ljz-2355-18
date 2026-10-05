<template>
  <div v-if="state.pageState !== 'current'" class="review-banner" :class="`is-${state.pageState}`">
    <div class="rb-title">
      <span class="rb-icon">{{ state.pageState === 'needs_verification' ? '⚠️' : '🛈' }}</span>
      {{ title }}
    </div>
    <p class="rb-desc">{{ desc }}</p>
    <!-- 维护者可见"为何超期"，而不是只有黄色标签 -->
    <details v-if="state.reasons?.length" class="rb-reasons">
      <summary>{{ zh ? '维护者：查看原因与待办' : 'Maintainers: why & open todos' }}</summary>
      <ul>
        <li v-for="(r, i) in state.reasons" :key="i">{{ r }}</li>
      </ul>
    </details>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
const props = defineProps({ state: { type: Object, required: true } })
const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')
const title = computed(() => {
  if (props.state.pageState === 'needs_verification') return zh.value ? '信息需核实' : 'Needs verification'
  return zh.value ? '尚未完成过完整复审' : 'Never fully reviewed'
})
const desc = computed(() => zh.value
  ? '复审到期或正文发生关键变化。系统仅提示核实，不会自动下线或改写历史内容；下方复审日期为最近一次完整通过声明范围的日期。'
  : 'Review is due or key content changed. We only flag it for verification — historical content is never removed or rewritten; the footer date is the last review that fully passed the declared scope.')
</script>

<style scoped>
.review-banner { border: 1px solid; border-radius: 8px; padding: 14px 18px; margin: 20px 0; }
.review-banner.is-needs_verification { border-color: #e6a23c; background: color-mix(in srgb,#e6a23c 10%,var(--vp-c-bg)); }
.review-banner.is-never_reviewed { border-color: var(--vp-c-brand); background: var(--vp-c-bg-soft); }
.rb-title { font-weight: 700; display: flex; align-items: center; gap: 8px; }
.rb-desc { margin: 6px 0 0; font-size: 13px; }
.rb-reasons { margin-top: 8px; font-size: 13px; }
.rb-reasons summary { cursor: pointer; color: var(--vp-c-brand); }
.rb-reasons ul { margin: 6px 0 0 18px; padding: 0; }
</style>
