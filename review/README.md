# 产品文档复审管理（Documentation Review Management）

面向产品文档的复审治理：**页脚三要素**（负责人 / 校验范围 / 日期）、按发布版生成的
**后台维护任务**、保存在 **PostgreSQL** 的责任交接与逐项审阅证据。

```
review/
├── sql/001_review_management.sql   # PG schema：任务/签收/证据/交接/触发台账/公开视图
├── src/
│   ├── review-service.js           # 领域服务（纯逻辑，clock 可注入）
│   ├── memory-repo.js              # ReviewRepository 内存实现（离线验收用）
│   ├── pg-repo.js                  # ReviewRepository 的 pg 实现（生产）
│   └── time.js                     # 站点时区（固定偏移 IANA 子集，UTC 存储）
└── test/acceptance.test.js         # 13 项验收场景（node:test，零三方依赖）
```

运行：

```bash
npm run review:test
```

## 需求 → 实现对照

| 需求 | 落地 |
| :--- | :--- |
| 页脚展示负责人、校验范围与日期 | `ReviewFooter.vue`；`getPublicFooter()`；`v_doc_public_review` |
| 后台按发布版生成维护任务 | `periodicScan({releaseId})` 按到期文档为每发布版建单 |
| PG 保存责任交接及审阅证据 | `doc_review_owner_history`（只追加，带禁改触发器）、`doc_review_claims`、`doc_review_item_results` |
| 离职/小组调整转派待办，不覆盖曾签收者 | `reassignOpenTodos()` 只改活跃任务 owner；`claims.signed_by` 永不更新 |
| 到期只提示信息需核实，不撤历史可读内容 | `expireDue()` 仅置 `stale`；公开页显示 `needs_verification` 横幅，旧日期/旧签收保留 |
| 检查一处示例 ≠ 整篇已复审 | 签收时按声明范围逐 required 项核对；缺项/fail 时 `full_scope=false` |
| 覆盖图必须满足声明范围 | `assertCoverageSatisfiesClaim()`；`CoverageGraph.vue` 可视化缺项 |
| 正文关键变化使相关项待重验 | `dependencyChanged()`：受影响 scope 回 `pending`，未受影响 carry-forward |
| 固定周期扫描 vs 依赖变更触发 | `periodic_scan` / `dependency_change` 两类来源，记录于 `sources` |
| 两类任务合并 | `merge_key = doc@release` + 部分唯一索引 `uq_review_task_active_merge` |
| 重复触发幂等 | `review_trigger_ledger` 主键 `ON CONFLICT DO NOTHING`；扫描/依赖/提醒重跑安全 |
| 站点时区切换 | 时刻以 epoch/`timestamptz` 存储，`zonedDate` 按站点偏移渲染本地日历日 |
| 无继任负责人 | 转派允许 `toOwnerId=null`；待办悬空可见，横幅与详情给出原因 |
| 部分检查失败可签收 | 允许 fail 留档签收；仅全部 required=pass 才推进公开日期 |
| 签收时页面更新 | `claims.doc_revision` 锚定签收时刻正文版本 |
| 提醒任务重跑 | `runDueReminders()` 以 `task:id:到期本地日` 去重，批次重跑跳过 |
| 公开日期反映真实完成范围 | 公开日期只取 `full_scope=true` 的最近签收 |
| 维护者看到为何超期 | `getOverdueDetail()` 汇总截止/离职/失败原因/正文变化；横幅可展开 |

## 关键状态机

```
periodic_scan / dependency_change
        │  (merge_key 命中活跃单 → 合并，不新建)
        ▼
     open ──录入检查项──▶ in_progress ──全部 required pass 签收──▶ signed
        ▲                    │  │
        │  正文关键变化       │  └─部分失败签收(留档)─▶ 仍 in_progress，可补检
        └────────────────────┘
   超过 dueAt / 覆盖被打破 ──▶ stale（信息需核实；历史内容与日期照常可读）
```

新一轮（正文变化于已签收之后）会从上一轮 claim **继承逐项证据**，仅把受影响 scope
置回 `pending`；旧 claim 永久保留，交接与签收历史不被改写。

## 公开页三种状态

- `current`：最近一次完整签收之后无正文变化、无超期活跃任务。
- `needs_verification`：复审到期或正文关键变化 —— **只提示**，不撤内容、不改日期。
- `never_reviewed`：从未有过覆盖整个声明范围的签收（页脚日期为空）。
