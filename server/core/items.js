// 审阅项（check item）与“声明校验范围”。
//
// 关键原则（来自需求）：
// - 检查一处示例不等于整篇已复审：示例/图（figure）是独立审阅项，必须逐项检查；
// - 审阅项覆盖图必须满足声明范围：frontmatter 中声明的 figure 与实际检查项做覆盖校验，
//   缺项或多查都不能签收；
// - 正文关键变化只会让“相关项”待重验，而不是清空历史签收。

export const ITEM_KINDS = /** @type {const} */ (['body', 'example', 'figure', 'table', 'config'])

// 每类审阅项的默认描述（i18n 在站点侧做，这里只存 key）
export const ITEM_KIND_LABEL_KEY = {
  body: 'review.item.body',
  example: 'review.item.example',
  figure: 'review.item.figure',
  table: 'review.item.table',
  config: 'review.item.config'
}

/**
 * 由文档清单构建审阅项。
 * manifest: { body: [{path, hash}], examples: [{path, hash}], figures: [...], tables: [...], configs: [...] }
 * 每个证据单元一个 item，避免“查了一个示例就算整篇通过”。
 */
export function buildItems(manifest) {
  const items = []
  for (const scope of ITEM_KINDS) {
    const list = manifest[scope === 'body' ? 'body' : `${scope}s`] || []
    for (const entry of list) {
      items.push({
        itemKey: `${scope}:${entry.path}`,
        kind: scope,
        path: entry.path,
        contentHash: entry.hash || null,
        // 声明范围：frontmatter 里声明过的 figure/table 才允许被签收（见 coverageCheck）
        declared: !!entry.declared
      })
    }
  }
  return items
}

/**
 * 覆盖校验：签收前调用。
 * @param items 本次任务实际生成的审阅项（带 declared 标记）
 * @param checkedItemKeys 本次准备签收为通过的 itemKey 集合
 * @param declaredScope frontmatter 声明的 scope 列表，如 ['body','examples','figures']
 * @returns {{ok: boolean, missing: string[], extra: string[], undeclared: string[]}}
 *   missing   声明范围内、但没有被检查通过的项（含图）
 *   extra     被检查通过、但不属于本任务的项
 *   undeclared 图/表被检查但 frontmatter 未声明（图必须满足声明范围）
 */
export function coverageCheck(items, checkedItemKeys, declaredScope) {
  const declared = new Set(declaredScope || [])
  const byKey = new Map(items.map((i) => [i.itemKey, i]))
  const checked = new Set(checkedItemKeys || [])

  // body / table / config 属于每篇文档的默认范围；examples / figures 必须显式声明。
  const DEFAULT_SCOPE = new Set(['body', 'table', 'config'])

  const missing = []
  for (const it of items) {
    const scopeName = it.kind === 'body' ? 'body' : `${it.kind}s`
    const inScope = DEFAULT_SCOPE.has(it.kind) || declared.has(scopeName)
    if (inScope && !checked.has(it.itemKey)) missing.push(it.itemKey)
  }

  const extra = []
  const undeclared = []
  for (const key of checked) {
    const it = byKey.get(key)
    if (!it) { extra.push(key); continue }
    if ((it.kind === 'figure' || it.kind === 'example') &&
        !declared.has(`${it.kind}s`)) {
      undeclared.push(key)
    }
  }
  return { ok: missing.length === 0 && extra.length === 0 && undeclared.length === 0, missing, extra, undeclared }
}

/**
 * 依赖（被引用文件）变化 -> 相关审阅项 key 列表。
 * 正文(markdown)关键变化影响 body；示例文件变化只影响对应 example 项；
 * 图片变化只影响对应 figure 项。不覆盖、不清空其它项的签收。
 */
export function affectedItemKeys(dependencyChanges) {
  const keys = []
  for (const c of dependencyChanges || []) {
    if (c.kind === 'body') keys.push(`body:${c.path}`)
    else keys.push(`${c.kind}:${c.path}`)
  }
  return keys
}
