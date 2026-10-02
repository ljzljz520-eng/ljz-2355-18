// 声明范围 / 审阅项覆盖图 工具
// 节点标识示例：examples/button/basic.vue、guide/quickstart.md#section-api

// glob -> 正则：支持 **（跨段）、*（单段内任意）、?
export function globToRe(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** ：跨任意路径段；吞掉紧随的 /
        i++
        if (pattern[i + 1] === '/') i++
        re += '.*'
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

export function matchNode(pattern, node) {
  if (pattern === node) return true
  return globToRe(pattern).test(node)
}

// 声明范围中每一个 pattern 必须至少被一个 active 审阅项的 node 覆盖
export function coverageGaps(declaredPatterns, itemNodes) {
  return declaredPatterns.filter(
    (d) => !itemNodes.some((n) => matchNode(d, n))
  )
}

// 某正文变化节点命中了哪些审阅项（正文关键变化 → 相关项待重验）
// 双向匹配：变化可能是具体文件、审阅项可能是上级 glob，反之亦然
export function itemsTouched(changedNodes, items) {
  return items.filter((it) =>
    changedNodes.some((cn) => matchNode(it.node, cn) || matchNode(cn, it.node))
  )
}
