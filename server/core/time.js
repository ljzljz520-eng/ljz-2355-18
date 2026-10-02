// 时区 / 日历日工具。
// 站点、任务到期、提醒全部以“站点配置时区”的日历日为准，而不是 UTC 日期。
// 这样在时区切换后，到期状态会随之改变，便于验收“时区切换”场景。

export const SUPPORTED_ZONES = [
  'UTC',
  'Asia/Shanghai',
  'Europe/Berlin',
  'America/Los_Angeles'
]

export const DEFAULT_ZONE = 'Asia/Shanghai'

export function assertZone(zone) {
  if (!SUPPORTED_ZONES.includes(zone)) {
    throw new Error(`Unsupported timezone: ${zone}. Allowed: ${SUPPORTED_ZONES.join(', ')}`)
  }
}

const DT_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
})

function utcParts(date) {
  const p = {}
  for (const { type, value } of DT_FORMAT.formatToParts(date)) p[type] = value
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour === 24 ? 0 : +p.hour,
    minute: +p.minute, second: +p.second
  }
}

/**
 * 把绝对时间 date 映射到 zone 本地的 Y/M/D/H/m/s
 */
export function zonedParts(date, zone) {
  assertZone(zone)
  // 用 Intl 读出 zone 下的本地挂钟分量，再用 UTC 构造器承载数值做日历运算
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  })
  const p = {}
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour === 24 ? 0 : +p.hour,
    minute: +p.minute, second: +p.second
  }
}

/**
 * zone 本地某日历日 00:00 对应的绝对 UTC 时间。
 * 先按偏移映射，再用 Intl 反查修正，天然兼容 DST。
 */
export function zonedDayStart(year, month, day, zone) {
  // 不动点迭代：guess 为 UTC 绝对时间；其在 zone 下的本地挂钟分量 (localDate,localHMS)
  // 与目标挂钟 (year-month-day 00:00) 之差，即为偏移修正量。DST 下通常 2~3 轮收敛。
  let guess = Date.UTC(year, month - 1, day)
  for (let i = 0; i < 6; i++) {
    const local = zonedParts(new Date(guess), zone)
    if (local.year === year && local.month === month && local.day === day &&
        local.hour === 0 && local.minute === 0 && local.second === 0) {
      return new Date(guess)
    }
    const localAsUTC = Date.UTC(local.year, local.month - 1, local.day,
      local.hour, local.minute, local.second)
    const targetAsUTC = Date.UTC(year, month - 1, day)
    guess += targetAsUTC - localAsUTC
  }
  return new Date(guess)
}

export function startOfToday(now, zone) {
  const p = zonedParts(now, zone)
  return zonedDayStart(p.year, p.month, p.day, zone)
}

/**
 * 在 zone 本地日历上加 days 天。
 */
export function addZonedDays(date, days, zone) {
  const p = zonedParts(date, zone)
  return zonedDayStart(p.year, p.month, p.day + days, zone)
}

function pad(n) { return String(n).padStart(2, '0') }

/**
 * 输出 YYYY-MM-DD HH:mm（zone 本地挂钟时间）
 */
export function formatZoned(date, zone, withTime = false) {
  if (!date) return ''
  const p = zonedParts(date, zone)
  const base = `${p.year}-${pad(p.month)}-${pad(p.day)}`
  return withTime ? `${base} ${pad(p.hour)}:${pad(p.minute)}` : base
}

/**
 * now 是否已经严格越过 dueDate（按 zone 的日历日比较，而不是 UTC 时间戳）
 */
export function isOverdue(dueDate, now, zone) {
  if (!dueDate) return false
  const a = zonedParts(now, zone)
  const b = zonedParts(dueDate, zone)
  const today = Date.UTC(a.year, a.month - 1, a.day)
  const due = Date.UTC(b.year, b.month - 1, b.day)
  return today > due
}

/**
 * zone 本地口径下 dueDate 距今天的天数（负数表示已超期几天）
 */
export function daysUntil(dueDate, now, zone) {
  if (!dueDate) return null
  const a = zonedParts(now, zone)
  const b = zonedParts(dueDate, zone)
  const today = Date.UTC(a.year, a.month - 1, a.day)
  const due = Date.UTC(b.year, b.month - 1, b.day)
  return Math.round((due - today) / 86400000)
}
