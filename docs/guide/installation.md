# 安装

## 使用包管理器

我们建议使用包管理器（NPM, Yarn, pnpm）安装。

```bash
npm install my-component-lib
```

<script setup lang="ts">
import { currentReview } from '../.vitepress/review-demo-data'
</script>

<ReviewStateBanner :state="currentReview" />
<ReviewFooter :state="currentReview" />
