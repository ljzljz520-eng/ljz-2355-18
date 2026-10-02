<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'
import { useReview } from './store.js'
import ZoneSwitch from './ZoneSwitch.vue'

const { lang } = useData()
const review = useReview(lang)
const { state, t } = review

const docs = computed(() => state.manifest?.docs || [])

function dayText(d) {
  if (d.daysLeft == null) return ''
  if (d.daysLeft === 0) return t('review.today')
  return d.daysLeft > 0 ? t('review.daysLeft').replace('{n}', d.daysLeft) : t('review.daysOverdue').replace('{n}', -d.daysLeft)
}
</script>

<template>
  <div v-if="state.loading && !state.manifest" class="rv-dash">Loading…</div>
  <div v-else-if="state.error" class="rv-dash rv-err">
    review-manifest.json 不可用（{{ state.error }}）。运行 <code>npm run review:seed</code> 生成演示数据。
  </div>
  <div v-else class="rv-dash">
    <div class="rv-dash-toolbar">
      <ZoneSwitch />
      <span class="rv-muted">{{ state.manifest?.generatedAtText }} · {{ docs.length }} docs</span>
    </div>

    <div class="rv-cards">
      <div class="rv-card" v-for="d in docs" :key="d.docId" :class="`card-${d.status}`">
        <div class="rv-card-head">
          <a :href="d.route">{{ d.title }}</a>
          <span :class="['rv-pill', `rv-${d.status}`]">{{ t(`review.status.${d.status}`) }}</span>
        </div>
        <div class="rv-card-meta">
          <span>{{ t('review.owner') }}: {{ d.owner ? d.owner.name : '—' }}</span>
          <span>
            {{ t('review.due') }}: {{ review.fmtDate(d.dueDate) }}
            <em :class="{ neg: d.daysLeft < 0 }">{{ dayText(d) }}</em>
          </span>
          <span>{{ t('review.publicDate') }}: {{ review.fmtDate(d.publicDate, true) || '—' }}</span>
        </div>

        <!-- 进度条：通过/失败/待验（一处示例不等于整篇，按 item 统计） -->
        <div class="rv-bar" v-if="d.items.total">
          <div class="seg seg-pass" :style="{ width: (d.items.passed / d.items.total * 100) + '%' }"></div>
          <div class="seg seg-fail" :style="{ width: (d.items.failed / d.items.total * 100) + '%' }"></div>
          <div class="seg seg-pend" :style="{ width: (d.items.pending / d.items.total * 100) + '%' }"></div>
        </div>
        <div class="rv-bar-label">{{ d.items.passed }}✓ / {{ d.items.failed }}✗ / {{ d.items.pending }}⏳ · {{ d.items.total }}</div>

        <!-- 维护者：为什么是这个状态，而不只是黄色标签 -->
        <ul v-if="d.reasons" class="rv-why">
          <li v-for="c in d.reasons.codes" :key="c">
            <span class="rv-dot" :data-code="c"></span>{{ t(`review.reason.${c}`) }}
          </li>
        </ul>

        <div class="rv-card-foot">
          <span>{{ t('review.verifiedScope') }}:
            <template v-if="d.verifiedScope.length">
              <span v-for="s in d.verifiedScope" :key="s" class="rv-chip">{{ review.scopeLabel(s) }}</span>
            </template>
            <span v-else class="rv-muted">—</span>
          </span>
          <span v-if="d.stale" class="rv-stale-tag">stale</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rv-dash { margin: 12px 0 32px; }
.rv-dash-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 8px; }
.rv-muted { color: var(--vp-c-text-2); font-size: 12.5px; }
.rv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.rv-card { border: 1px solid var(--vp-c-divider); border-left-width: 4px; border-radius: 10px; padding: 12px 14px; background: var(--vp-c-bg); }
.card-overdue { border-left-color: #d23f36; }
.card-due_soon { border-left-color: #d4a017; }
.card-partial_failed { border-left-color: #d9832e; }
.card-owner_missing { border-left-color: #963cb4; }
.card-in_review { border-left-color: var(--vp-c-divider); }
.card-verified { border-left-color: var(--vp-c-green-2); }
.rv-card-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 8px; }
.rv-card-head a { font-weight: 600; }
.rv-pill { font-size: 11.5px; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
.rv-verified { color: var(--vp-c-green-2); background: color-mix(in srgb, var(--vp-c-green-2) 12%, transparent); }
.rv-due_soon { color: #8a6200; background: rgba(230, 180, 0, .15); }
.rv-overdue { color: #a32018; background: rgba(220, 60, 50, .12); }
.rv-partial_failed { color: #9a5010; background: rgba(220, 140, 40, .14); }
.rv-owner_missing { color: #6b2780; background: rgba(150, 60, 180, .12); }
.rv-in_review { color: var(--vp-c-text-2); background: var(--vp-c-bg-soft); }
.rv-card-meta { display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; color: var(--vp-c-text-2); }
.rv-card-meta em { font-style: normal; margin-left: 4px; }
.rv-card-meta em.neg { color: #b4231a; font-weight: 600; }
.rv-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 10px 0 2px; background: var(--vp-c-bg-soft); }
.seg { height: 100%; }
.seg-pass { background: var(--vp-c-green-2); }
.seg-fail { background: #d23f36; }
.seg-pend { background: #c9b37a; }
.rv-bar-label { font-size: 11.5px; color: var(--vp-c-text-2); }
.rv-why { margin: 8px 0; padding-left: 0; list-style: none; font-size: 12.5px; }
.rv-why li { margin: 2px 0; color: var(--vp-c-text-1); }
.rv-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #d4a017; margin-right: 6px; }
.rv-dot[data-code="owner_missing"] { background: #963cb4; }
.rv-dot[data-code="failed_items"] { background: #d23f36; }
.rv-dot[data-code="content_changed_pending"] { background: #d9832e; }
.rv-card-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--vp-c-text-2); margin-top: 8px; }
.rv-chip { display: inline-block; padding: 0 7px; margin-right: 4px; border: 1px solid var(--vp-c-divider); border-radius: 999px; }
.rv-stale-tag { font-size: 10.5px; padding: 1px 7px; border-radius: 4px; background: var(--vp-c-bg-soft); border: 1px dashed var(--vp-c-divider); }
.rv-err { color: #b4231a; }
</style>
