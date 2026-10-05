<template>
  <footer class="review-footer" :class="`is-${state.pageState}`">
    <div class="rf-row rf-main">
      <div class="rf-item">
        <span class="rf-label">{{ t.owner }}</span>
        <span class="rf-value">{{ state.owner?.name || t.none }}</span>
      </div>
      <div class="rf-item">
        <span class="rf-label">{{ t.scope }}</span>
        <span class="rf-value">
          <code class="rf-scope">{{ state.scope?.fingerprint || '—' }}</code>
          <button class="rf-link" type="button" @click="showScope = !showScope">
            {{ showScope ? t.hideItems : t.showItems }} ({{ state.scopeItems.length }})
          </button>
        </span>
      </div>
      <div class="rf-item">
        <span class="rf-label">{{ t.date }}</span>
        <span class="rf-value">{{ state.signedAtText || t.never }}</span>
      </div>
    </div>

    <!-- 复审到期/正文变化：只提示"信息需核实"，不撤掉历史可读内容 -->
    <div v-if="state.pageState === 'needs_verification'" class="rf-row rf-notice">
      <span class="rf-dot" aria-hidden="true"></span>
      <span>{{ t.needsVerification }}</span>
      <ul v-if="state.reasons.length" class="rf-reasons">
        <li v-for="(r, i) in state.reasons" :key="i">{{ r }}</li>
      </ul>
    </div>

    <ul v-if="showScope" class="rf-row rf-items">
      <li v-for="it in state.scopeItems" :key="it.ref" :class="`res-${it.result}`">
        <span class="rf-kind">{{ it.kind }}</span>
        <span>{{ it.label }}</span>
        <span class="rf-result">{{ resultText(it.result) }}</span>
      </li>
    </ul>

    <div class="rf-row rf-fineprint">
      <span>{{ t.fineprint }}</span>
      <span v-if="state.todo.length">
        {{ t.currentTodo }}：{{ state.todo.map(x => x.ownerName || t.noSuccessor).join('、') }}
      </span>
    </div>
  </footer>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useData } from 'vitepress'

const props = defineProps({
  state: { type: Object, required: true }
})
const { lang } = useData()
const showScope = ref(false)

const zh = {
  owner: '负责人', scope: '校验范围', date: '复审日期',
  none: '尚未指定', never: '从未完成完整复审',
  showItems: '查看明细', hideItems: '收起明细',
  needsVerification: '信息需核实：本页部分内容可能已过期（复审到期或正文发生关键变化）。历史内容仍可正常阅读，公开日期保留为最近一次完整复审日期。',
  fineprint: '页脚信息来自复审台账：仅当声明范围内全部检查项通过，公开日期才会更新。',
  currentTodo: '当前待办', noSuccessor: '暂无继任负责人',
  pending: '待重验', pass: '通过', fail: '未通过'
}
const en = {
  owner: 'Owner', scope: 'Verified scope', date: 'Review date',
  none: 'unassigned', never: 'no full review yet',
  showItems: 'details', hideItems: 'hide',
  needsVerification: 'Needs verification: some content may be outdated (review due or key content changed). Historical content remains readable; the date below is the last fully completed review.',
  fineprint: 'Footer data comes from the review ledger: the public date advances only when every item in the claimed scope passes.',
  currentTodo: 'Open todo', noSuccessor: 'no successor owner',
  pending: 're-check', pass: 'pass', fail: 'fail'
}
const t = computed(() => (lang.value === 'zh-CN' ? zh : en))
function resultText(r) {
  return t.value[r] || r
}
</script>

<style scoped>
.review-footer {
  margin-top: 48px;
  padding: 16px 20px;
  border: 1px solid var(--vp-c-gutter);
  border-left-width: 4px;
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.review-footer.is-current { border-left-color: var(--vp-c-green-2, #67c23a); }
.review-footer.is-needs_verification { border-left-color: #e6a23c; }
.review-footer.is-never_reviewed { border-left-color: var(--vp-c-danger-2, #f56c6c); }
.rf-row { display: flex; flex-wrap: wrap; gap: 10px 28px; align-items: baseline; margin: 4px 0; }
.rf-item { display: flex; gap: 8px; align-items: baseline; }
.rf-label { font-weight: 600; color: var(--vp-c-text-1); }
.rf-scope { font-size: 12px; }
.rf-link {
  border: none; background: none; padding: 0; cursor: pointer;
  color: var(--vp-c-brand); font-size: 12px;
}
.rf-notice {
  margin-top: 10px; padding: 8px 12px;
  background: color-mix(in srgb, #e6a23c 12%, transparent);
  border-radius: 4px; color: #a6741a; flex-direction: column; align-items: flex-start; gap: 4px;
}
.rf-dot { width: 8px; height: 8px; border-radius: 50%; background: #e6a23c; display: inline-block; margin-right: 6px; }
.rf-reasons { margin: 4px 0 0 18px; padding: 0; }
.rf-reasons li { margin: 2px 0; }
.rf-items { list-style: none; margin: 8px 0 0; padding: 8px 0 0; border-top: 1px dashed var(--vp-c-gutter); }
.rf-items li { display: flex; gap: 8px; padding: 2px 0; }
.rf-kind {
  font-size: 11px; padding: 0 6px; border-radius: 3px;
  background: var(--vp-c-bg-alt); color: var(--vp-c-text-2); height: 18px; line-height: 18px;
}
.rf-result { margin-left: auto; font-weight: 600; }
.res-pass .rf-result { color: #67c23a; }
.res-fail .rf-result { color: #f56c6c; }
.res-pending .rf-result { color: #e6a23c; }
.rf-fineprint { margin-top: 10px; justify-content: space-between; opacity: .85; }
</style>
