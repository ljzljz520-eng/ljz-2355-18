// 时区工具：所有时刻内部一律存 UTC 毫秒；tz 只影响周期桶与展示。
const DAY = 86400000

// 取某 UTC 时刻在指定 IANA 时区的日历字段
function zonedParts(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })
  const p = {}
  for (const { type, value } of dtf.formatToParts(new Date(ms))) p[type] = Number(value)
  return p
}

// 该时刻对应"本地午夜"的 UTC 毫秒
export function zonedMidnight(ms, tz) {
  const p = zonedParts(ms, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day)
  // 用偏移量反推：本地午夜 = 该瞬间(按本地标签读出00:00) - offset
  const p2 = zonedParts(asUtc, tz)
  const offsetMin = p2.hour * 60 + p2.minute
  return asUtc - offsetMin * 60000
}

// 在 tz 内给 ms 加 n 个本地日（对 DST 稳健：始终落在目标日的本地午夜）
export function plusDays(ms, n, tz) {
  const start = zonedMidnight(ms, tz)
  const epochMidnight = zonedMidnight(0, tz)
  const dayIndex = Math.round((start - epochMidnight) / DAY)
  return epochMidnight + (dayIndex + n) * DAY
}

// 周期桶：以 tz 本地日历日为刻度，按 Unix 纪元起算，periodDays 天为一桶
export function periodBucket(ms, periodDays, tz) {
  const start = zonedMidnight(ms, tz)
  const epochMidnight = zonedMidnight(0, tz)
  const dayIndex = Math.round((start - epochMidnight) / DAY)
  const bucketIndex = Math.floor(dayIndex / periodDays)
  return epochMidnight + bucketIndex * periodDays * DAY
}

export function toDate(v) {
  return v instanceof Date ? v.getTime() : new Date(v).getTime()
}

export function diffDays(a, b, tz) {
  return Math.round((zonedMidnight(toDate(a), tz) - zonedMidnight(toDate(b), tz)) / DAY)
}

// YYYY-MM-DD HH:mm z（公开页脚/维护者排障使用）
export function formatInTz(ms, tz) {
  const p = zonedParts(toDate(ms), tz)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${tz})`
}

export function isoDay(ms, tz) {
  const p = zonedParts(toDate(ms), tz)
  const pad = (n) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}
