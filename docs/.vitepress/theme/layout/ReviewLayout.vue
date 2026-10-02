<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import ReviewFooter from '../components/ReviewFooter.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #doc-bottom>
      <div class="container">
        <ReviewFooter />
      </div>
    </template>
  </Layout>
</template>

<style scoped>
.container {
  padding: 0 24px;
  max-width: 688px;
  margin: 0 auto;
}
@media (min-width: 768px) {
  .container { max-width: 752px; }
}
@media (min-width: 960px) {
  .container { max-width: 832px; }
}
</style>
