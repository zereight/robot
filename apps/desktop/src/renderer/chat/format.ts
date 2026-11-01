import type { Locale } from "@robot/shared"

export const formatTime = (locale: Locale, at: number) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at)

export const formatDay = (
  locale: Locale,
  at: number,
  today: string,
  yesterday: string,
  now = Date.now(),
) => {
  const day = (t: number) => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const diff = Math.round((day(now) - day(at)) / 86_400_000)
  if (diff === 0) return today
  if (diff === 1) return yesterday
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(at)
}

/** Elapsed time as m:ss. */
export const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
