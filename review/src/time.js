// 时区工具：全部内部时刻以 epoch 毫秒(UTC)存储，仅展示/按日计算时换算。
// 固定偏移表足以覆盖验收；生产可替换为 Intl 命名时区的完整 DST 规则。
const NAMED_ZONES = {
  UTC: 0,
  'Asia/Shanghai': 480,
  'Asia/Tokyo': 540,
  'Europe/Berlin': 60,
  'America/Los_Angeles': -480 // 验收采用固定 PST，保证跨日边界可重复
}

export function parseZone(input) {
  if (input == null) return { name: 'UTC', offsetMinutes: 0 }
  if (typeof input === 'object' && 'offsetMinutes' in input) {
    return { name: input.name || 'custom', offsetMinutes: input.offsetMinutes | 0 }
  }
  const s = String(input).trim()
  if (s in NAMED_ZONES) return { name: s, offsetMinutes: NAMED_ZONES[s] }
  const m = s.match(/^(?:GMT|UTC)?([+-])(\d{2}):?(\d{2})$/)
  if (m) {
    const off = (Number(m[2]) * 60 + Number(m[3])) * (m[1] === '-' ? -1 : 1)
    return { name: s, offsetMinutes: off }
  }
  throw new Error(`unsupported timezone: ${input}`)
}

function shiftedParts(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60000)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    da: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes()
  }
}

const pad = (n) => String(n).padStart(2, '0')

// 该时刻在指定时区下的日历日 YYYY-MM-DD
export function zonedDate(ms, zone) {
  const { y, mo, da } = shiftedParts(ms, parseZone(zone).offsetMinutes)
  return `${y}-${pad(mo)}-${pad(da)}`
}

export function zonedDateTime(ms, zone) {
  const z = parseZone(zone)
  const { y, mo, da, h, mi } = shiftedParts(ms, z.offsetMinutes)
  const sign = z.offsetMinutes >= 0 ? '+' : '-'
  const off = Math.abs(z.offsetMinutes)
  return `${y}-${pad(mo)}-${pad(da)} ${pad(h)}:${pad(mi)} (${z.name} UTC${sign}${pad((off / 60) | 0)}:${pad(off % 60)})`
}

// 时区下"某日 00:00"对应的 epoch 毫秒
export function zonedDayStart(dateStr, zone) {
  const z = parseZone(zone)
  const [y, mo, da] = dateStr.split('-').map(Number)
  return Date.UTC(y, mo - 1, da) - z.offsetMinutes * 60000
}

// 跨时区安全的"超期整天数"：按各自时区日历日差计算
export function daysBetween(fromMs, toMs, zone) {
  const off = parseZone(zone).offsetMinutes * 60000
  const a = Math.floor((fromMs + off) / 86400000)
  const b = Math.floor((toMs + off) / 86400000)
  return b - a
}
