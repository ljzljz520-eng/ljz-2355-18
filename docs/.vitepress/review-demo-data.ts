// 复审台账前端契约示例：字段与 /review 后台 ReviewService.getPublicFooter()
// 及 getOverdueDetail() 输出一一对应。生产环境由 PG 视图 v_doc_public_review
// / v_doc_overdue_reasons 经 API 提供；静态站演示使用此处快照。
export interface ScopeItem {
  ref: string
  kind: 'example' | 'section' | 'diagram' | 'api'
  label: string
  result: 'pass' | 'pending' | 'fail'
  failReason?: string
}

export interface ReviewState {
  docId: string
  pageState: 'current' | 'needs_verification' | 'never_reviewed'
  owner: { id: string; name: string } | null
  scope: { fingerprint: string } | null
  signedAtText: string | null
  scopeItems: ScopeItem[]
  reasons: string[]
  todo: { taskId: string; ownerName: string | null; dueText: string; status: string }[]
}

const baseItems: ScopeItem[] = [
  { ref: 'examples/button/basic.vue', kind: 'example', label: '基础按钮示例 / Basic button demo', result: 'pass' },
  { ref: 'examples/button/variant.vue', kind: 'example', label: '变体按钮示例 / Variant button demo', result: 'pass' },
  { ref: 'coverage/install-flow', kind: 'diagram', label: '安装流程图 / Installation flow diagram', result: 'pass' }
]

export const currentReview: ReviewState = {
  docId: 'guide/installation',
  pageState: 'current',
  owner: { id: 'u_wangwu', name: '王五（王五于 2026-09-20 签收；前任李华的签收记录永久保留）' },
  scope: { fingerprint: 'sfp_8ab56e4a_3' },
  signedAtText: '2026-09-20 15:32 (Asia/Shanghai UTC+08:00)',
  scopeItems: baseItems,
  reasons: [],
  todo: []
}

export const needsVerificationReview: ReviewState = {
  docId: 'guide/quickstart',
  pageState: 'needs_verification',
  // 历史签收人不变 —— 转派只改待办，不覆盖曾签收者
  owner: { id: 'u_lihua', name: '李华（历史签收）' },
  scope: { fingerprint: 'sfp_8ab56e4a_3' },
  signedAtText: '2026-08-02 10:05 (Asia/Shanghai UTC+08:00)',
  scopeItems: [
    { ref: 'examples/button/basic.vue', kind: 'example', label: '基础按钮示例', result: 'pending' },
    { ref: 'examples/button/variant.vue', kind: 'example', label: '变体按钮示例', result: 'pass' },
    { ref: 'coverage/install-flow', kind: 'diagram', label: '安装流程图', result: 'pass' }
  ],
  reasons: [
    '正文/依赖变化：2026-09-28 基础示例 API 调用改写，相关项回到待重验',
    '已超过复审截止 2026-10-02（维护任务 task_102）',
    '当前待办无继任负责人（原负责人李华已离职，待办悬空，等待小组转派）'
  ],
  todo: [{ taskId: 'task_102', ownerName: null, dueText: '2026-10-02 07:00 (UTC+08:00)', status: 'stale' }]
}

export const declaredScope = [
  { ref: 'examples/button/basic.vue', kind: 'example', label: '基础按钮示例' },
  { ref: 'examples/button/variant.vue', kind: 'example', label: '变体按钮示例' },
  { ref: 'coverage/install-flow', kind: 'diagram', label: '安装流程图' }
]
