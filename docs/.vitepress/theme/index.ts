import DefaultTheme from 'vitepress/theme'
import VpDemo from './components/VpDemo.vue'
import VpApi from './components/VpApi.vue'
import BaseButton from './components/BaseButton.vue'
import ReviewFooter from './components/ReviewFooter.vue'
import ReviewStateBanner from './components/ReviewStateBanner.vue'
import CoverageGraph from './components/CoverageGraph.vue'
import ZoneSwitch from './components/ZoneSwitch.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('VpDemo', VpDemo)
    app.component('VpApi', VpApi)
    app.component('BaseButton', BaseButton)
    app.component('ReviewFooter', ReviewFooter)
    app.component('ReviewStateBanner', ReviewStateBanner)
    app.component('CoverageGraph', CoverageGraph)
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
