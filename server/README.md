# 产品文档复审管理（后台）

纯领域逻辑 + 可替换存储（内存 / PostgreSQL）。前台 VitePress 消费
`docs/public/review-manifest.json`（公开清单，不含内部敏感信息）。

## 目录

```
server/
  core/
    engine.js      # 复审引擎：任务生成/合并/幂等、检查、签收、交接、提醒、公开清单
    items.js       # 审阅项构建 + 声明范围覆盖校验（图必须满足声明范围）
    keys.js        # 固定/变更/提醒三类幂等键
    time.js        # 站点时区下的日历日运算（到期、剩余天数）
    errors.js
  store/
    memory.js      # 内存仓储（演示 / 单测）
    pg.js          # PostgreSQL 仓储（参数化查询，接口同构）
  db/schema.sql    # 表结构 + 签收/交接/证据 append-only 触发器
  cli/
    seed.js        # 生成演示数据并导出公开清单
    init-db.js     # 初始化 PG
  test/engine.test.js
```

## 快速体验

```bash
npm run review:test     # 20 个领域/验收测试
npm run review:seed     # 生成 docs/public/review-manifest.json
npm run docs:dev        # 打开 /guide/review-admin 查看管理台
```

## PostgreSQL

```bash
createdb docs
DATABASE_URL=postgres://postgres:postgres@localhost:5432/docs npm run review:db:init
```

```js
import { ReviewEngine } from './server/core/engine.js'
import { PgRepo } from './server/store/pg.js'

const repo = new PgRepo({ connectionString: process.env.DATABASE_URL })
await repo.init()
const engine = new ReviewEngine({ repo, zone: 'Asia/Shanghai' })
await engine.publishRelease({ id: '2026.10', name: '2026.10 发布版' })

// 1) 固定周期扫描（后台定时任务，按发布版）
await engine.scanFixed('2026.10', manifests)

// 2) 依赖变更触发（CI 在正文/示例/图变更时投递）
await engine.triggerDependencyChange('2026.10', [
  { docId: 'doc_button', kind: 'example', path: 'examples/button/basic.vue', hash: 'sha256:...' }
])

// 3) 提醒扫描（每天）；可安全重跑
await engine.runReminders()

// 4) 导出公开清单
const manifest = await engine.buildManifest()
```

## 两类触发的比较

| 维度 | 固定周期扫描 (`scanFixed`) | 依赖变更触发 (`triggerDependencyChange`) |
| :--- | :--- | :--- |
| 触发源 | 定时器 / 发布版事件 | CI 检测到正文、示例、图、表内容 hash 变化 |
| 到期日 | 按文档 `cycleDays`（如 90 天） | 较短的变更 SLA（默认 7 天） |
| 审阅项 | 按 manifest 全量建立（缺则补） | 只让**相关项**回到待重验 |
| 重复执行 | 幂等键 `fixed:<release>:<doc>` | 幂等键 `change:<release>:<doc>:<kind>:<path>:<hash>` |
| 合并 | 同一发布版 open 任务合并；旧发布版任务变 `superseded` | 同左（双向合并，取更早到期日） |

签收/交接/证据在 PG 中由 `trg_*_immutable` 触发器禁止 `UPDATE`/`DELETE`。
