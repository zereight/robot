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

/** A file size for a chip, for example "1.5 MB". */
export const fileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A date and a time, for example "Nov 2, 2026, 3:04 PM". */
export const formatDateTime = (locale: Locale, at: number) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at)
