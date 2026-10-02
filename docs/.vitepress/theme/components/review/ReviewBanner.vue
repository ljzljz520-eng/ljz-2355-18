<script setup>
import { computed, ref } from 'vue'
import { useData } from 'vitepress'
import { useReview } from './store.js'

const { lang, page } = useData()
const review = useReview(lang)
const { t } = review
const dismissed = ref(false)

const routeNorm = computed(() => {
  let rel = page.value.relativePath.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')
  return ('/' + rel).replace(/\/$/, '') || '/'
})
const entry = computed(() =>
  page.value.frontmatter?.review?.enabled ? review.entryByRoute(routeNorm.value) : null)

// 到期/失败/无负责人 才出现横幅；verified/in_review 不打扰阅读。
const show = computed(() =>
  !dismissed.value && entry.value &&
  ['due_soon', 'overdue', 'partial_failed', 'owner_missing'].includes(entry.value.status))

const tone = computed(() => {
  if (!entry.value) return ''
  if (entry.value.status === 'overdue') return 'rv-banner-danger'
  if (entry.value.status === 'owner_missing') return 'rv-banner-purple'
  if (entry.value.status === 'partial_failed') return 'rv-banner-warn'
  return 'rv-banner-warn'
})
</script>

<template>
  <div v-if="show" :class="['rv-banner', tone]">
    <div class="rv-banner-main">
      <span class="rv-banner-title">⚠️ {{ t(`review.status.${entry.status}`) }}</span>
      <!-- 维护者可见“为什么”，而不只是一个黄色标签 -->
      <ul v-if="entry.reasons" class="rv-reasons">
        <li v-for="c in entry.reasons.codes" :key="c">{{ t(`review.reason.${c}`) }}</li>
      </ul>
      <p class="rv-banner-sub">
        {{ t('review.due') }}: {{ review.fmtDate(entry.dueDate) }} ·
        {{ entry.reasons?.detail.failedCount ?? 0 }} failed /
        {{ entry.reasons?.detail.pendingCount ?? 0 }} pending
      </p>
      <p class="rv-banner-read">
        {{ t('review.stale') }}
      </p>
    </div>
    <button class="rv-dismiss" @click="dismissed = true">×</button>
  </div>
  <div v-else-if="entry?.stale" class="rv-banner rv-banner-info">
    ℹ️ {{ t('review.stale') }}
  </div>
</template>

<style scoped>
.rv-banner {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin: 18px 0 8px;
  padding: 12px 16px;
  border-radius: 10px;
  font-size: 13.5px;
  border: 1px solid transparent;
}
.rv-banner-warn { background: rgba(230, 180, 0, 0.1); border-color: rgba(200, 150, 0, 0.4); color: #7a5a00; }
.rv-banner-danger { background: rgba(220, 60, 50, 0.08); border-color: rgba(200, 50, 40, 0.4); color: #8e2018; }
.rv-banner-purple { background: rgba(150, 60, 180, 0.08); border-color: rgba(130, 50, 160, 0.4); color: #5e2270; }
.rv-banner-info { background: var(--vp-c-bg-soft); border-color: var(--vp-c-divider); color: var(--vp-c-text-2); }
.rv-banner-main { flex: 1; }
.rv-banner-title { font-weight: 700; }
.rv-reasons { margin: 6px 0 4px; padding-left: 18px; }
.rv-reasons li { margin: 2px 0; }
.rv-banner-sub, .rv-banner-read { margin: 4px 0 0; opacity: 0.85; }
.rv-banner-read { font-size: 12.5px; }
.rv-dismiss {
  border: none; background: transparent; font-size: 18px; cursor: pointer;
  color: inherit; opacity: 0.6; line-height: 1;
}
.rv-dismiss:hover { opacity: 1; }
</style>
