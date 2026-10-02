# 项目开发记录：基于 VitePress 的 Element Plus 风格文档系统

## 1. 核心思考与规划

### 1.1 需求本质分析
用户需求的核心在于构建一个不仅能看（文档），还能跑（组件示例），且长得像 Element Plus 的系统。关键技术挑战在于：
- **Markdown 与 Vue 的融合**：如何让 Markdown 中的代码块既能作为源码展示，又能作为实时组件运行。
- **自动化**：减少开发者的重复工作，实现“写一个 Vue 文件，出一份 Demo 文档”。

### 1.2 技术选型
- **基础引擎**：VitePress 1.x（目前最先进的 Vue 文档工具）。
- **Demo 方案**：采用 `markdown-it-container` 拦截 `::: demo` 块，配合 Vite 的 `import.meta.glob` 实现动态渲染。
- **样式方案**：Sass + CSS Variables，便于定制 Element 风格。

## 2. 执行过程记录

### 第一阶段：基础搭建
1. 初始化项目，安装 `vitepress`, `vue`, `sass`。
2. 配置多语言结构（zh/en），设置侧边栏和导航栏基础路由。

### 第二阶段：核心组件开发
1. 开发 `VpDemo.vue`：模仿 Element Plus 的代码卡片，包含预览区、描述区和折叠代码区。
2. 开发 `VpApi.vue`：用于展示组件参数，使用 Element 标志性的表格样式。

### 第三阶段：自动化插件实现
1. 编写 Markdown 插件逻辑：
   - 监听 `::: demo` 容器。
   - 从容器内容中提取 Vue 示例文件路径。
   - 读取文件源码，通过 `markdown-it` 再次渲染为代码块。
   - 渲染自定义组件 `<demo-xxx />`。
2. 实现自动注册：在 `theme/index.ts` 中利用 `glob` 自动扫码并注册所有示例。

### 第四阶段：问题排查与修复
1. **ESM 冲突**：修复了 `package.json` 中 `type` 字段冲突导致的启动失败。
2. **解析报错**：修复了 Markdown 与 Vue 模板混合时由于换行符导致的 Token 偏移错误。
3. **本地搜索**：在配置文件中一键开启内置本地搜索。

## 3. 设计亮点
- **零手动注册**：开发者只需在 `examples/` 文件夹下添加 `.vue` 文件，即可在任何 Markdown 中引用，极大提升了开发效率。
- **极致还原**：不仅是颜色，在代码折叠交互、API 表格间距等细节上均贴合 Element Plus 规范。

## 4. 文档复审管理（第二轮迭代）

### 4.1 需求拆解
将密集的中文需求拆为三组可独立验收的能力：
1. **站点展示**：页脚（负责人/校验范围/日期）、到期横幅（只提示不撤内容）、管理台（含时区切换与“为何超期”）。
2. **后台领域**：按发布版生成任务；固定周期扫描 vs 依赖变更触发两类来源；合并与幂等；逐项检查/签收/部分失败；责任交接（离职/小组调整）；提醒扫描。
3. **持久化**：PG 保存责任交接与审阅证据，签收/交接/证据 append-only（DB 触发器兜底）。

### 4.2 关键设计决策
- **审阅项即证据单元**：正文、每个示例、每张图、每张表独立成 item（`core/items.js`）。`coverageCheck` 保证图必须落在 frontmatter `declaredScope` 内，且声明范围逐项被 passed 才能签收——从机制上杜绝“查了一个示例就算整篇通过”。
- **hash 语义**：item.contentHash 表示“已按该版本检查过”。依赖触发只把相关项置 pending、**不**更新 hash；reviewer 带着页面实查 hash 复核时才刷新。于是“检查后页面又更新”在 `recordCheck`（前置防线）与 `signoff`（最终防线）两处都能被 CONTENT_CHANGED 拦截。
- **幂等键三段式**（`core/keys.js`）：`fixed:<release>:<doc>`、`change:<release>:<doc>:<kind>:<path>:<hash>`、`reminder:<task>:<winStart>:<winEnd>`。提醒重跑命中同键只累加 runCount，不产生重复通知。
- **合并语义**：同发布版 open 任务双向合并（triggerIds/reasons 并集，到期日只提前不延后）；新发布版固定扫描把旧版未完成任务标记 `superseded`——保留历史但不再作为状态来源。
- **时区**：所有绝对时间用 timestamptz/epoch，站点按配置时区做**日历日**比较（`core/time.js` 不动点迭代求本地午夜，兼容 DST）。同一绝对时刻在不同站点时区可能给出不同到期判定（测试 18 覆盖）。
- **责任不可覆盖**：`docs.owner_id` 只代表当前待办负责人；真实责任链在 `handovers`，签收者在 `signoffs.by_user`。PG 触发器在数据库层禁止 UPDATE/DELETE。
- **公开清单只读投影**：`buildManifest()` 只输出站点需要的字段；publicDate/verifiedScope 永远来自最近一次真实签收，反映真实完成范围。

### 4.3 工程结构
- 领域逻辑纯 JS、零框架依赖，内存仓储即可完整跑通；PG 仓储（`store/pg.js`）接口同构，`pg` 为可选依赖。
- 24 个 node:test 用例覆盖全部验收点：时区切换、无继任负责人、部分检查失败、签收时页面更新、提醒任务重跑、两类任务合并、重复触发幂等。
- 种子 CLI 锚定“当天 10:00（上海）”，保证演示数据每天可复现。

### 4.4 踩到的坑
- VitePress 的 Layout 插槽 `doc-before/doc-after` 用于挂横幅与页脚，避免侵入各 Markdown；SSR 时清单尚未 fetch，组件在客户端挂载后渲染（类名在 theme chunk 中）。
- jsonb 与 text[] 同名字段（reminders.reasons 是 jsonb，tasks.reasons 是 text[]）必须按「实体.字段」精确标注序列化，不能按列名全局处理。
