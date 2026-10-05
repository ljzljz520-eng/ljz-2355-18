<template>
  <label class="zone-switch">
    <span>{{ zh ? '站点时区' : 'Site timezone' }}</span>
    <select :value="modelValue" @change="onChange">
      <option v-for="z in zones" :key="z.value" :value="z.value">{{ z.label }}</option>
    </select>
  </label>
</template>

<script setup>
import { useData } from 'vitepress'
import { computed } from 'vue'
const props = defineProps({ modelValue: String })
const emit = defineEmits(['update:modelValue'])
const { lang } = useData()
const zh = computed(() => lang.value === 'zh-CN')
const zones = [
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai (UTC+08:00)' },
  { value: 'UTC', label: 'UTC (UTC±00:00)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (UTC+09:00)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (UTC+01:00)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (UTC−08:00)' }
]
function onChange(e) { emit('update:modelValue', e.target.value) }
</script>

<style scoped>
.zone-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--vp-c-text-2); }
select {
  padding: 4px 8px; border-radius: 4px; border: 1px solid var(--vp-c-gutter);
  background: var(--vp-c-bg); color: var(--vp-c-text-1);
}
</style>
