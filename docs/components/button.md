---
review:
  owner: Bob 李
  declaredScope: [examples/**, api/**]
  scope: [examples/button/basic.vue, api/button]
  signer: Bob 李
  outcome: full
  signedAt: '2026-10-02T02:00:00Z'
  periodDays: 90
  tz: Asia/Shanghai
  status: verified
---

# Button 按钮

常用的操作按钮。

## 基础用法

基础的按钮用法。

::: demo 基础按钮示例
examples/button/basic.vue
:::

## API

### Attributes

<VpApi :props="[{ name: 'type', description: '类型', type: 'string', default: 'default' }]" />