<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useData } from 'vitepress'
import { getReview, type ReviewRecord } from '../../review/registry'

const { lang, page, isDark } = useData()

// 优先读 frontmatter.review（页面自证），否则回落类型化注册表
const review = computed<ReviewRecord | null>(() => {
  const fm = (page.value.frontmatter ?? {}) as any
  if (fm.review) return normalizeFrontmatter(fm.review)
  return getReview(page.value.relativePath ? '/' + page.value.relativePath.replace(/\.md$/, '') : page.value.filePath || '')
})

function normalizeFrontmatter(r: any): ReviewRecord {
  return {
    owner: r.owner,
    declaredScope: r.declaredScope ?? [],
    lastSignoff: {
      by: r.signer ?? r.owner,
      outcome: r.outcome ?? 'full',
      signedAt: r.signedAt,
      scope: { covered: r.scope ?? [], failed: r.failed ?? [] }
    },
    periodDays: r.periodDays ?? 90,
    tz: r.tz ?? 'Asia/Shanghai',
    staleByContent: r.staleByContent ?? false,
    status: r.status ?? 'verified',
    overdueReasons: r.overdueReasons ?? []
  }
}

// ---- 时区切换：底层 ISO 时刻不变，仅换算展示；选择持久化 ----
const TZ_OPTIONS = ['Asia/Shanghai', 'UTC']
const displayTz = ref('Asia/Shanghai')
onMounted(() => {
  displayTz.value = review.value?.tz || localStorage.getItem('review-tz') || 'Asia/Shanghai'
})
watch(displayTz, (v) => localStorage.setItem('review-tz', v))

function zonedParts(iso: string, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  })
  const p: Record<string, number> = {}
  for (const part of dtf.formatToParts(new Date(iso))) p[part.type] = Number(part.value)
  return p
}
function formatDate(iso: string) {
  const p = zonedParts(iso, displayTz.value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

const isZh = computed(() => lang.value === 'zh-CN')
const t = (zh: string, en: string) => (isZh.value ? zh : en)

const verified = computed(() => review.value?.status === 'verified' && !review.value?.staleByContent)
const isPartial = computed(() => review.value?.lastSignoff.outcome === 'partial')

const scopeText = computed(() => {
  const s = review.value?.lastSignoff.scope
  if (!s) return ''
  const covered = s.covered.join(', ')
  if (isPartial.value) {
    const failed = (s.failed ?? []).map((f) => `${f.node}（${f.note}）`).join('；')
    return isZh.value
      ? `仅 ${covered} 已校验通过；未覆盖：${failed}`
      : `Verified: ${covered}. Not covered: ${(s.failed ?? []).map((f) => `${f.node} (${f.note})`).join('; ')}`
  }
  return covered
})
</script>

<template>
  <div v-if="review" class="review-footer" :class="{ 'is-dark': isDark }">
    <div class="rf-head">
      <span class="rf-badge" :class="verified ? 'ok' : 'warn'">
        {{ verified
          ? t('✓ 信息已核实', '✓ Information verified')
          : t('⚠ 信息需核实', '⚠ Verification needed') }}
      </span>
      <span class="rf-title">{{ t('文档复审信息', 'Documentation review') }}</span>
      <span class="rf-tz">
        <button
          v-for="z in TZ_OPTIONS"
          :key="z"
          class="rf-tz-btn"
          :class="{ active: displayTz === z }"
          @click="displayTz = z"
        >{{ z === 'Asia/Shanghai' ? t('上海', 'Shanghai') : 'UTC' }}</button>
      </span>
    </div>

    <dl class="rf-grid">
      <div>
        <dt>{{ t('负责人', 'Owner') }}</dt>
        <dd>{{ review.owner }}</dd>
      </div>
      <div>
        <dt>{{ isPartial ? t('实际校验范围', 'Verified scope (actual)') : t('校验范围', 'Verified scope') }}</dt>
        <dd :class="{ partial: isPartial }">{{ scopeText }}</dd>
      </div>
      <div>
        <dt>{{ t('声明范围', 'Declared scope') }}</dt>
        <dd>{{ review.declaredScope.join(', ') }}</dd>
      </div>
      <div>
        <dt>{{ t('完成日期', 'Completed on') }}</dt>
        <dd>
          {{ formatDate(review.lastSignoff.signedAt) }}
          <span class="rf-zone">{{ displayTz }}</span>
          <span class="rf-signer">· {{ t('签收', 'signed by') }} {{ review.lastSignoff.by }}</span>
        </dd>
      </div>
      <div>
        <dt>{{ t('复审周期', 'Review cycle') }}</dt>
        <dd>{{ review.periodDays }} {{ t('天', 'days') }}</dd>
      </div>
    </dl>

    <!-- 到期/待核实：只做提示，历史内容不撤、仍可阅读 -->
    <div v-if="!verified" class="rf-notice">
      <strong>{{ t('为什么显示此提示？', 'Why this notice?') }}</strong>
      <ul>
        <li v-for="(r, i) in review.overdueReasons" :key="i">{{ r }}</li>
        <li v-if="!review.overdueReasons?.length">
          {{ t('复审周期已到或正文有关键变化，相关信息需要重新核实；历史内容仍保留可读。',
               'The review cycle elapsed or the content changed; the information needs re-verification. Historical content remains readable.') }}
        </li>
      </ul>
      <span class="rf-hint">{{ t('提示仅表示“需要核实”，不代表内容已被撤下。',
        'This notice means verification is due — content is never removed.') }}</span>
    </div>
  </div>
</template>

<style scoped>
.review-footer {
  margin: 48px 0 24px;
  padding: 16px 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  line-height: 1.7;
}
.rf-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.rf-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 12px;
}
.rf-badge.ok {
  color: var(--vp-c-green-2, #3a9f5f);
  background: color-mix(in srgb, var(--vp-c-green-2, #3a9f5f) 12%, transparent);
}
.rf-badge.warn {
  color: #b88230;
  background: rgba(230, 162, 60, 0.14);
}
.rf-title { font-weight: 600; color: var(--vp-c-text-1); }
.rf-tz { margin-left: auto; display: inline-flex; gap: 4px; }
.rf-tz-btn {
  border: 1px solid var(--vp-c-divider);
  background: transparent;
  color: var(--vp-c-text-2);
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 12px;
  cursor: pointer;
}
.rf-tz-btn.active {
  border-color: var(--vp-c-brand);
  color: var(--vp-c-brand);
  font-weight: 600;
}
.rf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 8px 20px;
  margin: 0;
}
.rf-grid dt {
  color: var(--vp-c-text-2);
  font-size: 12px;
}
.rf-grid dd {
  margin: 0 0 4px;
  color: var(--vp-c-text-1);
  word-break: break-word;
}
.rf-grid dd.partial { color: #b88230; }
.rf-zone { color: var(--vp-c-text-2); font-size: 12px; margin-left: 4px; }
.rf-signer { color: var(--vp-c-text-2); font-size: 12px; }
.rf-notice {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--vp-c-divider);
  color: var(--vp-c-text-2);
}
.rf-notice ul { margin: 4px 0 4px 18px; padding: 0; }
.rf-hint { font-size: 12px; opacity: 0.85; }
</style>
