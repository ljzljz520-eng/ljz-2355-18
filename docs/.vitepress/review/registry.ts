// 文档复审信息注册表（构建期静态数据，对应后台 publicFooter 视图）
// 生产环境可由发布流水线从 PG 导出生成本文件；这里提供演示数据。
export interface ReviewScopeEntry {
  /** 实际完成校验的覆盖节点（glob） */
  covered: string[]
  /** 本次未通过、仍需整改的节点 */
  failed?: { node: string; note: string }[]
}

export interface ReviewRecord {
  /** 当前负责人（转派后为继任者） */
  owner: string
  /** 声明的校验范围（覆盖图必须满足它） */
  declaredScope: string[]
  /** 最近一次签收：outcome=full 为整篇通过，partial 仅代表 listed 范围 */
  lastSignoff: {
    by: string
    outcome: 'full' | 'partial'
    signedAt: string // ISO，按页面配置时区展示
    scope: ReviewScopeEntry
  }
  /** 复审周期（天）与站点时区；周期桶按此时区折算 */
  periodDays: number
  tz: string
  /** 正文是否在签收后发生关键变化（相关项待重验） */
  staleByContent?: boolean
  /** 维护者超期原因（公开端仅展示摘要） */
  status: 'verified' | 'needs_verification'
  overdueReasons?: string[]
}

// key = 规范化路由
export const reviewRegistry: Record<string, ReviewRecord> = {
  '/components/button': {
    owner: 'Bob 李',
    declaredScope: ['examples/**', 'api/**'],
    lastSignoff: {
      by: 'Bob 李',
      outcome: 'full',
      signedAt: '2026-10-02T02:00:00Z',
      scope: { covered: ['examples/button/basic.vue', 'api/button'] }
    },
    periodDays: 90,
    tz: 'Asia/Shanghai',
    status: 'verified'
  },
  '/guide/quickstart': {
    owner: 'Carol 王',
    declaredScope: ['guide/**', 'examples/**'],
    lastSignoff: {
      by: 'Alice 张（已转岗，记录保留）',
      outcome: 'partial',
      signedAt: '2026-07-15T06:30:00Z',
      scope: {
        covered: ['guide/quickstart.md'],
        failed: [{ node: 'examples/**', note: '快速开始中的安装示例未随 v2.1 重验' }]
      }
    },
    periodDays: 90,
    tz: 'Asia/Shanghai',
    staleByContent: true,
    status: 'needs_verification',
    overdueReasons: [
      '签收后正文有关键更新，examples 相关审阅项已升版本待重验',
      '原负责人 Alice 转岗后由 Carol 接任，交接期间任务顺延'
    ]
  }
}

export function getReview(routePath: string): ReviewRecord | null {
  const norm = routePath.replace(/\.(html|md)$/g, '').replace(/\/$/, '') || '/'
  return reviewRegistry[norm] || reviewRegistry[routePath] || null
}
