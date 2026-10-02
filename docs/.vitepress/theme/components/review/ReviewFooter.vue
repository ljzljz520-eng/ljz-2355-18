<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
import { useReview } from './store.js'

const { lang, page } = useData()
const review = useReview(lang)
const { state, t, fmtDate, scopeLabel } = review

// 仅在 frontmatter 声明 review: true 的页面挂载；route 用相对路径匹配清单
const routeNorm = computed(() => {
  let rel = page.value.relativePath.replace(/\.md$/, '')
  rel = rel.replace(/(^|\/)index$/, '$1')
  return ('/' + rel).replace(/\/$/, '') || '/'
})

const entry = computed(() =>
  page.value.frontmatter?.review?.enabled ? review.entryByRoute(routeNorm.value) : null)

const statusClass = computed(() => `rv-status rv-${entry.value?.status || 'none'}`)
const dayText = computed(() => {
  if (!entry.value || entry.value.daysLeft == null) return ''
  const n = entry.value.daysLeft
  if (n === 0) return t('review.today')
  return n > 0 ? t('review.daysLeft').replace('{n}', n) : t('review.daysOverdue').replace('{n}', -n)
})
</script>

<template>
  <div v-if="entry" class="rv-footer">
    <div class="rv-footer-row rv-footer-head">
      <span class="rv-title">📋 {{ t('review.label') }}</span>
      <span :class="statusClass">{{ t(`review.status.${entry.status}`) }}</span>
    </div>

    <dl class="rv-footer-grid">
      <dt>{{ t('review.owner') }}</dt>
      <dd>{{ entry.owner ? entry.owner.name : '—' }}</dd>

      <dt>{{ t('review.due') }}</dt>
      <dd>
        <span :class="{ 'rv-overdue': entry.daysLeft < 0, 'rv-soon': entry.daysLeft >= 0 && entry.daysLeft <= 3 }">
          {{ entry.dueDateText ? fmtDate(entry.dueDate) : '—' }}
        </span>
        <span v-if="dayText" class="rv-days">（{{ dayText }}）</span>
      </dd>

      <dt>{{ t('review.publicDate') }}</dt>
      <dd>
        <template v-if="entry.publicDateText">
          {{ fmtDate(entry.publicDate, true) }}
          <span v-if="entry.lastRelease" class="rv-muted">· {{ entry.lastRelease }}</span>
        </template>
        <span v-else class="rv-muted">—</span>
      </dd>

      <dt>{{ t('review.scope') }}</dt>
      <dd>
        <template v-if="entry.verifiedScope.length">
          <span v-for="s in entry.verifiedScope" :key="s" class="rv-chip rv-chip-ok">
            {{ scopeLabel(s) }}
          </span>
        </template>
        <span v-else class="rv-muted">—</span>
      </dd>
    </dl>

    <details v-if="entry.signoffHistory.length" class="rv-history">
      <summary>{{ t('review.signoffHistory') }}（{{ entry.signoffHistory.length }}）</summary>
      <ul>
        <li v-for="(h, i) in entry.signoffHistory" :key="i">
          <strong>{{ h.by }}</strong>
          <span class="rv-muted">{{ fmtDate(h.at, true) }} · {{ h.release }} · {{ h.scopeCount }} items</span>
        </li>
      </ul>
    </details>

    <p class="rv-footnote">
      {{ t('review.zone') }}: {{ state.zone }} ·
      <span class="rv-muted">{{ state.manifest?.generatedAtText }}</span>
    </p>
  </div>
</template>

<style scoped>
.rv-footer {
  margin-top: 48px;
  padding: 16px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background: var(--vp-c-bg-soft);
  font-size: 13.5px;
}
.rv-footer-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.rv-title { font-weight: 600; }
.rv-footer-grid {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 6px 14px;
  margin: 0;
}
.rv-footer-grid dt { color: var(--vp-c-text-2); margin: 0; }
.rv-footer-grid dd { margin: 0; }
.rv-chip {
  display: inline-block;
  padding: 1px 8px;
  margin-right: 6px;
  border-radius: 999px;
  font-size: 12px;
  border: 1px solid var(--vp-c-divider);
}
.rv-chip-ok { color: var(--vp-c-green-2); border-color: var(--vp-c-green-2); }
.rv-status { font-weight: 600; font-size: 12.5px; padding: 2px 10px; border-radius: 999px; }
.rv-verified { color: var(--vp-c-green-2); background: color-mix(in srgb, var(--vp-c-green-2) 12%, transparent); }
.rv-in_review { color: var(--vp-c-text-2); }
.rv-due_soon { color: #b88500; background: rgba(230, 180, 0, 0.12); }
.rv-overdue, .rv-status.rv-overdue { color: #b4231a; }
.rv-status.rv-overdue { background: rgba(220, 60, 50, 0.1); }
.rv-status.rv-partial_failed { color: #b4530a; background: rgba(220, 140, 40, 0.12); }
.rv-status.rv-owner_missing { color: #7a2d8a; background: rgba(150, 60, 180, 0.1); }
.rv-soon { color: #b88500; font-weight: 600; }
.rv-days { color: var(--vp-c-text-2); }
.rv-muted { color: var(--vp-c-text-2); }
.rv-history { margin-top: 10px; }
.rv-history ul { margin: 8px 0 0; padding-left: 18px; }
.rv-history li { margin: 3px 0; }
.rv-footnote { margin: 12px 0 0; color: var(--vp-c-text-2); font-size: 12px; }
</style>
