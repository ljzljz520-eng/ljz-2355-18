# 产品文档复审管理（review-system）

文档站的复审领域模型 + 后台任务服务 + VitePress 前端集成。
零第三方依赖即可跑通（JSON 仓储）；生产环境可切换到 PostgreSQL 仓储。

## 目录

```
review-system/
├── schema.sql          # PostgreSQL 建表脚本（签收/交接/证据/触发明细）
├── src/
│   ├── time.js         # 站点时区日历、周期到期换算（UTC 存储，时区推导）
│   ├── ReviewService.js# 核心领域服务：发布、扫描、依赖触发、签收、转派、提醒、超期原因
│   ├── repo-json.js    # JSON 文件仓储（自测/demo，零依赖）
│   ├── repo-pg.js      # PostgreSQL 仓储（与 JsonRepo 同接口，可选依赖 pg）
│   └── manifest.js     # 生成 VitePress 静态清单
├── selftest.mjs        # 11 组验收场景（npm run review:test）
├── demo.mjs            # 完整业务时间线演示（npm run review:demo）
└── data/state.json     # demo 运行后的领域状态（生成物）
```

前端：

```
docs/.vitepress/
├── review-data/manifest.json              # 前端只读清单（demo/后台任务生成物）
├── theme/composables/useReview.js          # 路径匹配、状态文案、维护者模式
└── theme/components/
    ├── ReviewLayout.vue                    # 布局插槽（顶部提示 + 页脚）
    ├── ReviewFooter.vue                    # 页脚：负责人 / 校验范围 / 日期
    ├── ReviewNotice.vue                    # 「信息需核实」提示条（不撤内容）
    └── ReviewBoard.vue                     # 复审面板（/review/board）
```

## 关键规则

| 规则 | 实现位置 |
| :--- | :--- |
| 任务按发布版生成 | `publishRelease()` |
| 周期扫描 + 依赖触发合并、重复幂等 | `runCycleScan()` / `triggerDependencyChange()` |
| 覆盖图必须满足声明范围 | `publishRelease()` 中的 `CoverageError` |
| 正文关键变化 → 相关项待重验 | 分块内容 hash + `dependsOn` |
| 一处示例通过 ≠ 整篇通过 | `recordCheck()` 按 covers 统计覆盖率 |
| 公开日期=真实完整完成时刻 | `#evaluateRelease()`（仅全覆盖时写入） |
| 到期只提示、不撤历史内容 | `statusOf()` 级别 `due-for-review/needs-recheck`；无任何删除/下线路径 |
| 转派待办不改写签收者 | `handover()` 只改 `docs.ownerId` 与打开任务 |
| 无继任 → 任务挂起 + 维护者待办 | 任务状态 `unassigned`、提醒落 `maintainer-backlog` |
| 提醒按任务+站点日+渠道幂等 | `runReminders()` |
| 维护者看到"为什么超期" | `explainOverdue()`（周期/依赖/交接/失败/重验/无主） |

## 使用

```bash
npm run review:test   # 运行 11 组验收
npm run review:demo   # 生成演示数据与前端清单
npm run docs:build    # 构建站点（页脚/提示/面板读取清单）
```

### 接入 PostgreSQL

```bash
psql "$DATABASE_URL" -f review-system/schema.sql
```

```js
import { PgRepo } from './review-system/src/repo-pg.js'
import { ReviewService } from './review-system/src/ReviewService.js'

const repo = await PgRepo.connect(process.env.DATABASE_URL)
const svc = new ReviewService({ repo, zone: 'Asia/Shanghai' })
```

`pg` 为可选依赖：`npm i pg`。JSON 仓储与 PG 仓储接口一致（`get/list/put`），
切换无需改领域代码。
