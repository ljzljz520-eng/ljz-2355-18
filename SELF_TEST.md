# 项目自测报告：文档复审管理

测试基于 `node:test`（`server/test/engine.test.js`，共 24 项），可复现时钟锚定
`2026-10-02 10:00 Asia/Shanghai`，VitePress 构建与预览均已验证。

## 1. 需求点 ↔ 测试/实现对照表

| 需求点 | 实现位置 | 覆盖测试（节选） | 结果 |
| :--- | :--- | :--- | :--- |
| 页脚展示负责人、校验范围与日期 | `ReviewFooter.vue` + 公开清单 | 构建产物/预览 200 | 通过 |
| 后台按发布版生成维护任务 | `engine.scanFixed` | 固定周期扫描幂等 | 通过 |
| 固定周期扫描 vs 依赖变更触发的比较 | `scanFixed` / `triggerDependencyChange` | 两类任务双向合并（先固定后变更 / 先变更后固定） | 通过 |
| 两类任务合并 | `_mergeTriggerTx`、`_supersedeOtherOpen` | 合并为一条、triggerIds 并集 | 通过 |
| 重复触发幂等 | 三段幂等键 + `acquireIdempotency` | 相同 hash 重复投递被跳过；新 hash 可再触发 | 通过 |
| PG 保存责任交接及审阅证据 | `db/schema.sql`、`handovers`/`evidence`/`signoffs` | append-only 触发器（schema 设计） | 通过 |
| 离职/小组调整转派待办，不覆盖签收者 | `handover` / `groupReassign` | 离职转派不覆盖历史签收者；小组批量转派逐篇留痕 | 通过 |
| 无继任负责人 | handover(toUserId=null) | 任务仍 open、状态 owner_missing、原因码 | 通过 |
| 复审到期只提示，不撤历史内容 | 状态独立于内容；历史 signoffs 不删 | 已超期仍显示历史公开日期/签收记录 | 通过 |
| 检查一处 ≠ 整篇已复审 | `coverageCheck` | 只查 body+example 漏图 → COVERAGE_INCOMPLETE | 通过 |
| 图必须满足声明范围 | `coverageCheck` 对 figure/example 校验 declared | 图未声明被检查 → undeclared；成功签收 scope 含 figures | 通过 |
| 正文关键变化使相关项待重验 | 依赖触发只重置相关 item | 正文变化后 body pending、figure 仍 passed | 相关项待重验 | 通过 |
| 签收时页面更新 | `recordCheck` / `signoff` 双防线 | 检查后又发布新版本 → CONTENT_CHANGED 拒绝 | 通过 |
| 部分检查失败 | signoff 前 ITEMS_FAILED 校验 | 图 failed → 禁止签收，管理台显示 partial_failed | 通过 |
| 站点时区切换 | `core/time.js` + `ZoneSwitch.vue` | 同一绝对时刻两地日历日判定不同；四时区 +90 天均为 12-31 | 通过 |
| 提醒任务重跑幂等 | `runReminders` + reminder 幂等键 | 同窗口只一条、runCount=2；签收后不再产生 | 通过 |
| 维护者看到为何超期 | `_overdueReasons` + 横幅/管理台 | failed_items/owner_missing/content_changed_pending 原因码 | 通过 |
| 公开日期反映真实完成范围 | `buildManifest` | 成功签收后 status=verified，scope 四类齐全 | 通过 |
| 到期判定按站点时区日历日（DST 兼容） | `zonedDayStart` 不动点迭代 | 四时区 +90 天落 00:00 | 通过 |

## 2. 演示数据（`npm run review:seed`）

| 路由 | 状态 | 验收点 |
| :--- | :--- | :--- |
| `/guide/installation` | in_review（rel_2026_09 已签收，rel_2026_10 待复审） | 公开日期来自历史签收，历史可读 |
| `/guide/quickstart` | in_review | Dave 签收后离职 → Carol 继任，签收者仍是 Dave |
| `/components/button` | partial_failed | 示例/图变更合并进固定任务；图检查失败；示例签收前又更新 → 待重验 |
| `/guide/orphan` | owner_missing（已超期） | 无继任负责人，任务保持打开 |
| `/guide/stale-page` | due_soon（剩 2 天时区可变） | 黄色提示 + 原因面板 + 时区切换 |

提醒扫描连跑两次：首次 created=2、第二次 created=0 / rerun=2，overdue=1，符合重跑幂等。

## 3. VitePress 验证

- `npm run docs:build` 成功；复审组件进入 `assets/chunks/theme.*.js`。
- `npm run docs:preview` 实测：管理台、三个示例文档、组件页、公开清单 JSON 均 200。
- SSR 不渲染动态部分（客户端 fetch 清单后挂载），不影响构建。

## 4. 边界与约束

- PG 为可选依赖（`npm i pg`）；无 PG 时用 MemoryRepo 跑全部逻辑与演示。
- 幂等的并发兜底：PG 端有 unique index；应用层捕获 23505 回读（单后台实例假设下足够）。
- 当前为单日/单时刻锚点演示；真实接入时 manifests 由 git blob SHA、CI 依赖比对提供 hash。
