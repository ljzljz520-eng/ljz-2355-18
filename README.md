# VitePress 文档系统 (Element Plus 风格)

本项目是一个基于 VitePress 搭建的高质量组件库文档模板，深度参考了 Element Plus 的交互体验与视觉风格。

## ✨ 特性

- 🚀 **自动化 Demo 提取**：使用 `::: demo` 语法自动读取 `.vue` 文件并生成预览与源码。
- 🌍 **内置国际化**：完善的中英文多语言切换支持。
- 🔍 **全文搜索**：集成 VitePress 本地搜索功能。
- 📊 **API 自动展示**：美观的组件属性（Attributes）表格。
- 🎨 **主题定制**：深度还原 Element Plus 的 UI 风格。

## 🚀 快速启动

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发服务器

```bash
npm run docs:dev
```

### 3. 构建静态站点

```bash
npm run docs:build
```

### 4. 预览构建效果

```bash
npm run docs:preview
```

## 📂 项目结构

- `docs/`：文档根目录
  - `.vitepress/`：配置与主题
  - `components/`：组件说明文档
  - `examples/`：存放所有的组件 Demo 示例代码
  - `guide/`：入门指南

## 🛠 语法说明

### 组件示例

使用 `::: demo [描述文本]` 块，并在其中写入示例文件的路径：

```markdown
::: demo 基础按钮用法
examples/button/basic.vue
:::
```


## 📋 文档复审管理（新增）

在文档站之上增加了「产品文档复审管理」能力：

- **页脚信息**：每个文档页脚展示负责人、校验范围、复审到期日、公开日期。
- **管理台**：[`docs/guide/review-admin.md`](docs/guide/review-admin.md) 汇总所有文档状态，支持**站点时区切换**（UTC/上海/柏林/洛杉矶），并展示「为什么超期」而非只有黄色标签。
- **后台任务**：按发布版生成维护任务，比较并合并**固定周期扫描**与**依赖变更触发**两类任务，重复触发/提醒重跑全部幂等。
- **责任与证据（PG）**：PostgreSQL 保存责任交接与审阅证据；签收/交接/证据 append-only，触发器禁止修改删除。负责人离职或小组调整只转派待办，**不覆盖历史签收者**。
- **精细审阅项**：检查一处示例不代表整篇已复审；正文/每个示例/每张图/每张表独立成项，图必须满足 frontmatter 声明范围；正文关键变化只让相关项待重验。
- **到期不撤内容**：复审到期只提示「信息需核实」，历史可读内容保留；公开日期反映真实完成范围。

```bash
npm run review:test     # 24 个领域/验收测试
npm run review:seed     # 生成演示公开清单 docs/public/review-manifest.json
npm run docs:dev        # 访问 /guide/review-admin
```

详见 [`server/README.md`](server/README.md)。
