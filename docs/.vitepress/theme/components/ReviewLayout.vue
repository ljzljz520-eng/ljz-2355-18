<script setup>
import { watch } from 'vue'
import { useRoute } from 'vitepress'
import DefaultTheme from 'vitepress/theme'
import ReviewFooter from './ReviewFooter.vue'
import ReviewNotice from './ReviewNotice.vue'
import { useReview } from '../composables/useReview.js'

const { Layout } = DefaultTheme
const route = useRoute()
const { entry, levelMeta, syncRoute } = useReview()

watch(() => route.path, p => syncRoute(p), { immediate: true })
</script>

<template>
  <Layout>
    <template #doc-before>
      <ReviewNotice v-if="entry" :entry="entry" :meta="levelMeta(entry.level)" />
    </template>
    <template #doc-footer-before>
      <ReviewFooter />
    </template>
  </Layout>
</template>
