// 幂等键（idempotency key）生成。
// 同一发布版 + 同一文档 + 同一触发原因 的任务只允许存在一条；
// 提醒任务重跑（相同窗口）也必须命中同一键，杜绝重复通知。

export function fixedScanKey(releaseId, docId) {
  return `fixed:${releaseId}:${docId}`
}

export function changeTriggerKey(releaseId, docId, depPath, depKind) {
  return `change:${releaseId}:${docId}:${depKind}:${depPath}`
}

export function reminderKey(taskId, windowStart, windowEnd) {
  return `reminder:${taskId}:${windowStart}:${windowEnd}`
}
