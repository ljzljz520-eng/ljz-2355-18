<script setup>
import { computed } from 'vue'
import { useReview } from '../composables/useReview.js'
import ReviewNotice from './ReviewNotice.vue'

const { entry, zone, levelMeta, state, toggleMaintainer, generatedAtLabel } = useReview()
const meta = computed(() => entry.value ? levelMeta(entry.value.level) : null)

function reasonTypeLabel(t) {
  return { cycle: '周期', dependency: '依赖', handover: '交接', 'check-failed': '检查失败', revalidate: '待重验', 'no-owner': '无负责人' }[t] || t
}
const fmt = (iso, withTime = true) => {
  if (!iso) return '—'
  const dt = new Date(iso)
  return new Intl.DateTimeFormat('zh-CN', withTime
    ? { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt)
}
</script>

<template>
  <footer class="rv-footer">
    <ReviewNotice v-if="entry" :entry="entry" :meta="meta" compact />
    <div v-if="entry" class="rv-footer__grid">
      <div class="rv-footer__cell">
        <span class="rv-footer__k">负责人</span>
        <span class="rv-footer__v">
          <template v-if="entry.owner">{{ entry.owner.name }}</template>
          <em v-else class="rv-footer__none">无继任负责人 · 待指派</em>
        </span>
      </div>
      <div class="rv-footer__cell">
        <span class="rv-footer__k">校验范围</span>
        <span class="rv-footer__v">
          <span class="rv-badge" :class="`rv-badge--${meta.tone}`">{{ meta.label }}</span>
          {{ entry.coverage.passed }}/{{ entry.coverage.total }} 项通过
        </span>
      </div>
      <div class="rv-footer__cell">
        <span class="rv-footer__k">复审日期</span>
        <span class="rv-footer__v">
          公开于 <strong :title="'站点时区 ' + zone">{{ fmt(entry.publicDate, false) }}</strong>
          · 应于 {{ fmt(entry.dueDate, false) }}
        </span>
      </div>
    </div>

    <!-- 维护者：为什么超期，而不只是一个黄色标签 -->
    <details v-if="state.maintainer && entry && entry.overdueReasons.length" class="rv-footer__why" open>
      <summary>🛠 维护者视图 · 超期原因（{{ entry.overdueReasons.length }}）</summary>
      <ul>
        <li v-for="(r, i) in entry.overdueReasons" :key="i">
          <span class="rv-why-type">{{ reasonTypeLabel(r.type) }}</span>{{ r.text }}
        </li>
      </ul>
    </details>

    <div class="rv-footer__meta">
      <span>复审清单生成于 {{ generatedAtLabel }}（{{ zone }}）</span>
      <button class="rv-link-btn" @click="toggleMaintainer">
        {{ state.maintainer ? '退出维护者视图' : '维护者入口' }}
      </button>
      <a class="rv-link-btn" href="/review/board">复审面板</a>
    </div>
  </footer>
</template>


<style scoped>
.rv-footer {
  margin: 48px auto 24px;
  max-width: var(--vp-layout-max-width);
  padding: 20px 24px;
  border-top: 1px solid var(--vp-corpse-divider, var(--vp-c-divider));
  color: var(--vp-c-text-2);
  font-size: 13px;
}
.rv-footer__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px 24px;
  margin: 12px 0;
}
.rv-footer__cell { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.rv-footer__k { color: var(--vp-c-text-3); white-space: nowrap; }
.rv-footer__v { color: var(--vp-c-text-1); }
.rv-footer__none { color: var(--vp-c-danger-1); font-style: normal; }
.rv-footer__why {
  margin: 8px 0;
  padding: 10px 14px;
  border: 1px solid var(--vp-c-danger-soft, rgba(224, 114, 68, .3));
  border-radius: 8px;
  background: var(--vp-c-danger-soft-bg, rgba(224, 114, 68, .08));
}
.rv-footer__why summary { cursor: pointer; font-weight: 600; }
.rv-footer__why ul { margin: 8px 0 0; padding-left: 18px; }
.rv-footer__why li { margin: 4px 0; }
.rv-why-type {
  display: inline-block; min-width: 44px; margin-right: 6px;
  padding: 0 6px; border-radius: 4px; font-size: 11px;
  background: var(--vp-c-bg-soft); color: var(--vp-c-text-2);
}
.rv-footer__meta {
  display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  margin-top: 10px; color: var(--vp-c-text-3); font-size: 12px;
}
.rv-link-btn {
  border: none; background: none; cursor: pointer; padding: 0;
  color: var(--vp-c-brand-1); font-size: 12px;
}
.rv-link-btn:hover { text-decoration: underline; }
</style>
