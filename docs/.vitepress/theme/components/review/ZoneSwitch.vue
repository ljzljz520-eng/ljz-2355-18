<script setup>
import { useData } from 'vitepress'
import { useReview, REVIEW_ZONES } from './store.js'

const { lang } = useData()
const review = useReview(lang)
const { state } = review
</script>

<template>
  <label class="rv-zone">
    <span>{{ review.t('review.zone') }}</span>
    <select :value="state.zone" @change="review.setZone($event.target.value)">
      <option v-for="z in REVIEW_ZONES" :key="z" :value="z">{{ z }}</option>
    </select>
  </label>
</template>

<style scoped>
.rv-zone {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--vp-c-text-2);
}
.rv-zone select {
  padding: 2px 6px;
  font-size: 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}
</style>
