---
title: 产品文档复审管理
---

# 产品文档复审管理

本页说明文档复审（Review）治理机制。每一篇产品文档的**页脚**都会展示三要素：

- **负责人**：最近一次完整签收人（责任交接后也保留历史签收人，不覆盖）
- **校验范围**：签收时锚定的声明范围指纹与逐项明细
- **日期**：最近一次"声明范围全部通过"的签收日期，反映真实完成范围

<script setup lang="ts">
import { ref } from 'vue'
import { currentReview, needsVerificationReview, declaredScope } from '../.vitepress/review-demo-data'
import { zonedDate } from '../.vitepress/zoned-util'

const zone = ref('Asia/Shanghai')
const fmt = (iso: string) => {
  const ms = new Date(iso).getTime()
  return zonedDate(ms, zone.value)
}
</script>

<ZoneSwitch v-model="zone" />

## 1. 复审通过：页脚展示真实完成范围

<ReviewStateBanner :state="currentReview" />

<CoverageGraph :declared="declaredScope"
  :covered="{
    'examples/button/basic.vue': { result: 'pass' },
    'examples/button/variant.vue': { result: 'pass' },
    'coverage/install-flow': { result: 'pass' }
  }"
  doc-title="安装指南 · 声明范围" />

<ReviewFooter :state="currentReview" />

## 2. 到期 / 正文关键变化：只提示"信息需核实"

系统**不会**因为复审到期就下线或改写历史内容，只在页面顶部与页脚提示核实。
正文关键变化只让**相关检查项**回到"待重验"，不相关项继续有效。

<ReviewStateBanner :state="needsVerificationReview" />

<CoverageGraph :declared="declaredScope"
  :covered="{
    'examples/button/basic.vue': { result: 'pending' },
    'examples/button/variant.vue': { result: 'pass' },
    'coverage/install-flow': { result: 'pass' }
  }"
  doc-title="快速开始 · 覆盖图（一项待重验）" />

<ReviewFooter :state="needsVerificationReview" />

## 3. 覆盖图必须满足声明范围

检查了**一处示例不代表整篇已复审**。覆盖图（coverage graph）必须覆盖文档声明的全部必检项；
缺项时签收只能留档，不能推进公开日期：

<CoverageGraph :declared="declaredScope"
  :covered="{
    'examples/button/basic.vue': { result: 'pass' }
  }"
  doc-title="只检查了一个示例 → 不满足声明范围" />

## 4. 站点时区切换

复审截止与日期以 `timestamptz` 存储，按站点所选时区显示本地日历日。
当前时区 **{{ zone }}**，安装页最近签收日：**{{ fmt('2026-09-20T07:32:00Z') }}**
（同一时刻在 UTC−08:00 站点会显示为前一天）。

## 5. 责任交接与无继任负责人

- 负责人离职 / 小组调整：只把**待办任务**转派给继任者或小组，并向交接台账追加一条不可变记录。
- **已签收人永不被覆盖**：页脚负责人展示的是历史签收人；待办负责人单独列出。
- 暂无继任负责人时，待办保持悬空且对维护者可见，横幅中说明"无继任负责人"。

## 6. 后台两类维护任务

| 触发方式 | 行为 |
| :--- | :--- |
| 固定周期扫描 | 每个发布版为到期文档生成维护任务，给出站点时区下的截止时间 |
| 依赖变更触发 | 正文/上游关键变化时，受影响项回到待重验并建单 |

两类任务按 `(文档, 发布版)` **合并**为同一活跃单；触发台账保证扫描批次、依赖事件、
提醒批次重跑时**幂等**，不重复建单、不重复提醒。

## 7. 维护者可见"为何超期"

待办详情包含可读原因：超过截止时间、负责人离职且无继任、逐项失败原因、正文变化摘要——
而不是只有一个黄色标签。
