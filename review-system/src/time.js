// Time helpers.
//
// 全站时间以 UTC 存储；"周期"与"到期日"按站点时区的日历日计算。
// 切换站点时区（如 Asia/Shanghai <-> America/Los_Angeles）后，
// 同一发布日推导出的 dueDate 会落到不同的 UTC 时刻（见验收场景 1）。

const pad = n => String(n).padStart(2, '0')

/**
 * 将"某时区墙上的 YYYY-MM-DD HH:mm:ss"换算为 UTC Date。
 * 用 Intl 反查该时刻的 GMT 偏移，避开夏令时规则的手工维护。
 */
export function zonedToUtc(zone, datePart, hh = 0, mm = 0, ss = 0) {
  const guess = Date.parse(`${datePart}T${pad(hh)}:${pad(mm)}:${pad(ss)}Z`)
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
  const parts = dtf.formatToParts(new Date(guess))
  const gmt = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = gmt.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  let offsetMin = 0
  if (m) {
    offsetMin = (Number(m[2]) * 60 + Number(m[3] || 0)) * (m[1] === '-' ? -1 : 1)
  }
  return new Date(guess - offsetMin * 60_000)
}

/** 站点时区下某时刻的日历日 YYYY-MM-DD */
export function zonedDatePart(zone, instant) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(typeof instant === 'string' ? new Date(instant) : instant)
}

/** 站点时区下"今天"的日期部分 */
export function todayIn(zone, now = new Date()) {
  return zonedDatePart(zone, now)
}

/** 纯日历加天（不涉时区） */
export function addDatePart(datePart, days) {
  const [y, m, d] = datePart.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * 周期到期日 = 发布日(站点时区日历) + intervalDays 天，锚定到目标日 00:00 UTC。
 * 站点时区改变时，同一发布时刻推出的 dueDate 随之改变。
 */
export function dueFromPublish(zone, publishedAt, intervalDays) {
  const part = addDatePart(zonedDatePart(zone, publishedAt), intervalDays)
  return zonedToUtc(zone, part)
}

/** 依赖触发的再验证宽限到期：now 所在站点时区日历日 + graceDays */
export function dueFromNow(zone, now, graceDays) {
  const part = addDatePart(zonedDatePart(zone, now), graceDays)
  return zonedToUtc(zone, part)
}

/** 按站点时区格式化（页脚/面板使用） */
export function formatInZone(instant, zone, { withTime = true } = {}) {
  if (!instant) return ''
  const dt = typeof instant === 'string' ? new Date(instant) : instant
  const opts = withTime
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit' }
  return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, ...opts }).format(dt)
}

/** 站点时区下两个时刻是否同一日历日（提醒任务幂等键的基础） */
export function isSameZonedDay(zone, a, b) {
  return zonedDatePart(zone, a) === zonedDatePart(zone, b)
}
