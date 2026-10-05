# Installation

## Using Package Manager

We recommend installing using a package manager (NPM, Yarn, pnpm).

```bash
npm install my-component-lib
```
<script setup lang="ts">
import { currentReview } from '../../.vitepress/review-demo-data'
</script>

<ReviewStateBanner :state="currentReview" />
<ReviewFooter :state="currentReview" />
