export class ReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

export const Codes = {
  DOC_NOT_FOUND: 'DOC_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  NO_OWNER: 'NO_OWNER',                 // 无继任负责人
  COVERAGE_INCOMPLETE: 'COVERAGE_INCOMPLETE', // 声明范围未被检查覆盖
  ITEMS_FAILED: 'ITEMS_FAILED',         // 部分检查失败，不允许签收
  CONTENT_CHANGED: 'CONTENT_CHANGED',   // 检查后正文关键内容又变了，需要重验
  ALREADY_PROCESSED: 'ALREADY_PROCESSED',
  INVALID_STATE: 'INVALID_STATE'
}
