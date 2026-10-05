// 前端展示用时区工具（与 review/src/time.js 同规则的浏览器版，纯固定偏移）
const NAMED: Record<string, number> = {
  UTC: 0,
  'Asia/Shanghai': 480,
  'Asia/Tokyo': 540,
  'Europe/Berlin': 60,
  'America/Los_Angeles': -480
}
export function offsetMinutes(zone: string): number {
  if (zone in NAMED) return NAMED[zone]
  return 0
}
export function zonedDate(ms: number, zone: string): string {
  const d = new Date(ms + offsetMinutes(zone) * 60000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}
