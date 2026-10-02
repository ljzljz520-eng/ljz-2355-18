import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import VpDemo from './components/VpDemo.vue'
import VpApi from './components/VpApi.vue'
import BaseButton from './components/BaseButton.vue'
import ReviewFooter from './components/review/ReviewFooter.vue'
import ReviewBanner from './components/review/ReviewBanner.vue'
import ReviewDashboard from './components/review/ReviewDashboard.vue'
import ZoneSwitch from './components/review/ZoneSwitch.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  // 用 ReviewLayout 包住默认布局的文档插槽：
  // 每页顶部可显示复审提示横幅，页脚展示负责人/校验范围/日期。
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'doc-before': () => h(ReviewBanner),
      'doc-after': () => h(ReviewFooter)
    })
  },
  enhanceApp({ app }) {
    app.component('VpDemo', VpDemo)
    app.component('VpApi', VpApi)
    app.component('BaseButton', BaseButton)
    app.component('ReviewDashboard', ReviewDashboard)
    app.component('ReviewFooter', ReviewFooter)
    app.component('ZoneSwitch', ZoneSwitch)

    // Auto register examples
    const examples = import.meta.glob('../../examples/**/*.vue', { eager: true })
    for (const path in examples) {
      const name = path
        .replace('../../examples/', 'demo-')
        .replace(/\//g, '-')
        .replace('.vue', '')
      app.component(name, (examples[path] as any).default)
    }
  }
}
