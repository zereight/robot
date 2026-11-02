/** How often a routine or a workflow runs. All times are in the local time zone. */
export type Schedule =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "every"; readonly minutes: number; readonly from: number }
  | { readonly kind: "daily"; readonly times: readonly string[] }
  | { readonly kind: "weekly"; readonly days: readonly number[]; readonly time: string }
  | { readonly kind: "cron"; readonly expr: string }

export const EVERY_MIN_MINUTES = 1
/** A missed run that is later than this does not run on wake. */
export const MISSED_MAX_MS = 12 * 60 * 60 * 1000

const MINUTE = 60_000
const SEARCH_DAYS = 800

/** "09:30" as minutes since midnight, or null when it is not a time. */
export const parseTime = (text: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : null
}

interface CronField {
  readonly any: boolean
  readonly values: ReadonlySet<number>
}

const parseField = (text: string, min: number, max: number): CronField | null => {
  const values = new Set<number>()
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/")
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) return null
    let lo: number
    let hi: number
    if (range === "*") {
      lo = min
      hi = max
    } else if (/^\d+$/.test(range)) {
      lo = Number(range)
      hi = stepText === undefined ? lo : max
    } else {
      const m = /^(\d+)-(\d+)$/.exec(range)
      if (!m) return null
      lo = Number(m[1])
      hi = Number(m[2])
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return { any: text === "*", values }
}

interface Cron {
  readonly minute: CronField
  readonly hour: CronField
  readonly dom: CronField
  readonly month: CronField
  readonly dow: CronField
}

/** Five fields: minute hour day-of-month month day-of-week. Lists, ranges and steps work. */
export const parseCron = (expr: string): Cron | null => {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) return null
  const minute = parseField(f[0] ?? "", 0, 59)
  const hour = parseField(f[1] ?? "", 0, 23)
  const dom = parseField(f[2] ?? "", 1, 31)
  const month = parseField(f[3] ?? "", 1, 12)
  const dowRaw = parseField((f[4] ?? "").replace(/\b7\b/g, "0"), 0, 6)
  if (!minute || !hour || !dom || !month || !dowRaw) return null
  return { minute, hour, dom, month, dow: dowRaw }
}

const cronMatches = (c: Cron, d: Date) => {
  if (!c.minute.values.has(d.getMinutes()) || !c.hour.values.has(d.getHours())) return false
  if (!c.month.values.has(d.getMonth() + 1)) return false
  const domOk = c.dom.values.has(d.getDate())
  const dowOk = c.dow.values.has(d.getDay())
  // As in classic cron: when both day fields are restricted, either one may match.
  if (!c.dom.any && !c.dow.any) return domOk || dowOk
  return domOk && dowOk
}

/** Whether the schedule can be used. */
export const validSchedule = (s: Schedule): boolean => {
  switch (s.kind) {
    case "once":
      return Number.isFinite(s.at)
    case "every":
      return Number.isInteger(s.minutes) && s.minutes >= EVERY_MIN_MINUTES
    case "daily":
      return s.times.length > 0 && s.times.every((t) => parseTime(t) !== null)
    case "weekly":
      return (
        s.days.length > 0 &&
        s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
        parseTime(s.time) !== null
      )
    case "cron":
      return parseCron(s.expr) !== null
  }
}

const startOfDay = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d
}

const atMinutes = (day: Date, minutes: number) => {
  const d = new Date(day)
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d.getTime()
}

/** The run times after `after` (not including it), oldest first, up to `limit`, until `until`. */
export const runTimes = (
  s: Schedule,
  after: number,
  limit: number,
  until = Number.POSITIVE_INFINITY,
): number[] => {
  if (!validSchedule(s) || limit <= 0) return []
  const out: number[] = []
  const push = (t: number) => {
    if (t > after && t <= until && out.length < limit) out.push(t)
  }
  switch (s.kind) {
    case "once":
      push(s.at)
      return out
    case "every": {
      const step = s.minutes * MINUTE
      const first =
        after < s.from ? s.from : s.from + (Math.floor((after - s.from) / step) + 1) * step
      for (let t = first; out.length < limit && t <= until; t += step) push(t)
      return out
    }
    case "daily":
    case "weekly": {
      const minutes =
        s.kind === "daily"
          ? s.times.map((t) => parseTime(t) as number).sort((a, b) => a - b)
          : [parseTime(s.time) as number]
      for (let i = 0; i < SEARCH_DAYS && out.length < limit; i++) {
        const day = startOfDay(after)
        day.setDate(day.getDate() + i)
        if (s.kind === "weekly" && !s.days.includes(day.getDay())) continue
        for (const m of minutes) push(atMinutes(day, m))
        if (day.getTime() > until) break
      }
      return out
    }
    case "cron": {
      const cron = parseCron(s.expr) as Cron
      const d = new Date(after)
      d.setSeconds(0, 0)
      d.setMinutes(d.getMinutes() + 1)
      // Steps by minute inside a day, but jumps over days that cannot match.
      const end = Math.min(until, after + SEARCH_DAYS * 86_400_000)
      while (d.getTime() <= end && out.length < limit) {
        if (!cron.month.values.has(d.getMonth() + 1)) {
          d.setMonth(d.getMonth() + 1, 1)
          d.setHours(0, 0, 0, 0)
          continue
        }
        if (cronMatches(cron, d)) out.push(d.getTime())
        d.setMinutes(d.getMinutes() + 1)
      }
      return out
    }
  }
}

export type RoutineEntryState =
  | "planned"
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled"
  | "missed"
  | "skipped"

/**
 * What to do on a check, given the runs that came due since the last check. Only the newest run
 * may start, and only when it is less than 12 hours late. The others are missed.
 */
export const dueRuns = (
  s: Schedule,
  lastChecked: number,
  now: number,
): { start: number | null; missed: number[] } => {
  const due = runTimes(s, lastChecked, 1000, now)
  const newest = due.at(-1)
  if (newest === undefined) return { start: null, missed: [] }
  if (now - newest < MISSED_MAX_MS) return { start: newest, missed: due.slice(0, -1) }
  return { start: null, missed: due }
}
