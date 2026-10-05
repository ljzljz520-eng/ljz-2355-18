<template>
  <div class="coverage-graph">
    <div class="cg-legend">
      <span><i class="lg pass"></i>{{ zh ? '已通过' : 'Passed' }}</span>
      <span><i class="lg pending"></i>{{ zh ? '待重验' : 'Re-check' }}</span>
      <span><i class="lg fail"></i>{{ zh ? '未通过' : 'Failed' }}</span>
      <span><i class="lg uncovered"></i>{{ zh ? '声明范围未覆盖' : 'Declared but uncovered' }}</span>
    </div>
    <div class="cg-canvas">
      <div class="cg-doc">
        <strong>{{ docTitle }}</strong>
        <em>{{ zh ? '声明范围必须被全部覆盖' : 'declared scope must be fully covered' }}</em>
      </div>
      <div class="cg-links" aria-hidden="true"></div>
      <ul class="cg-nodes">
        <li v-for="n in mergedNodes" :key="n.ref" :class="nodeClass(n)">
          <span class="cg-kind">{{ kindText(n.kind) }}</span>
          <span class="cg-label">{{ n.label }}</span>
          <span v-if="n.failReason" class="cg-reason">{{ n.failReason }}</span>
        </li>
      </ul>
    </div>
    <p class="cg-verdict" :class="satisfies ? 'ok' : 'bad'">
      <template v-if="satisfies">✓ {{ zh ? '覆盖图满足声明范围' : 'Coverage satisfies the declared scope' }}</template>
      <template v-else>
        ✗ {{ zh ? `覆盖不完整：${uncoveredList.length} 项声明范围缺失（检查一处示例不代表整篇已复审）`
                : `${uncoveredList.length} declared item(s) uncovered — checking one demo is not a full review` }}
      </template>
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'

const props = defineProps({
  declared: { type: Array, required: true }, // [{ref,kind,label}]
  covered: { type: Array, required: true },  // { [ref]: { result, failReason } }
  docTitle: { type: String, default: '' }
})
const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')

const coveredMap = computed(() => {
  const m = {}
  for (const [ref, v] of Object.entries(props.covered)) m[ref] = v
  return m
})
const mergedNodes = computed(() =>
  props.declared.map((d) => ({ ...d, ...(coveredMap.value[d.ref] || { result: 'uncovered' }) })))
const uncoveredList = computed(() => mergedNodes.value.filter((n) => n.result === 'uncovered'))
const satisfies = computed(() => uncoveredList.value.length === 0)
function nodeClass(n) { return [`res-${n.result}`] }
function kindText(k) {
  const map = { example: zh.value ? '示例' : 'demo', section: zh.value ? '章节' : 'section',
    diagram: zh.value ? '图' : 'diagram', api: 'API' }
  return map[k] || k
}
</script>

<style scoped>
.coverage-graph { border: 1px solid var(--vp-c-gutter); border-radius: 6px; padding: 16px; margin: 16px 0; background: var(--vp-c-bg); }
.cg-legend { display: flex; gap: 18px; font-size: 12px; color: var(--vp-c-text-2); flex-wrap: wrap; }
.cg-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
.lg.pass { background: #67c23a; } .lg.pending { background: #e6a23c; }
.lg.fail { background: #f56c6c; } .lg.uncovered { background: repeating-linear-gradient(45deg,#ccc,#ccc 3px,#fff 3px,#fff 6px); }
.cg-canvas { position: relative; margin: 14px 0; }
.cg-doc { display: inline-block; border: 2px solid var(--vp-c-brand); border-radius: 6px; padding: 8px 14px; background: var(--vp-c-bg-soft); }
.cg-doc em { display: block; font-style: normal; font-size: 11px; color: var(--vp-c-text-2); }
.cg-nodes { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.cg-nodes li { border: 1px solid var(--vp-c-gutter); border-left-width: 4px; border-radius: 4px; padding: 8px 10px; font-size: 13px; background: var(--vp-c-bg); }
.cg-nodes.res-pass { border-left-color: #67c23a; }
.cg-nodes.res-pending { border-left-color: #e6a23c; }
.cg-nodes.res-fail { border-left-color: #f56c6c; }
.cg-nodes.res-uncovered { border-left-color: #909399; border-style: dashed; }
.cg-kind { font-size: 11px; background: var(--vp-c-bg-alt); padding: 0 6px; border-radius: 3px; margin-right: 6px; }
.cg-reason { display: block; margin-top: 4px; font-size: 12px; color: #f56c6c; }
.cg-verdict { margin: 12px 0 0; font-weight: 600; font-size: 13px; }
.cg-verdict.ok { color: #67c23a; }
.cg-verdict.bad { color: #e6a23c; }
</style>
