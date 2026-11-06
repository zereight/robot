import type { Locale } from "@robot/shared"

export const formatTime = (locale: Locale, at: number) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at)

/**
 * The time at which a limit resets or a hold ends (spec 006). A time within the day is the clock
 * time. A later one names the weekday too, because a weekly limit resets days from now.
 */
export const formatUntil = (locale: Locale, at: number, now = Date.now()) =>
  new Intl.DateTimeFormat(
    locale,
    at - now < 20 * 3_600_000
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" },
  ).format(at)

/** A date and a time, for a record such as "Last changed by". */
export const formatDateTime = (locale: Locale, at: number) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at)

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

/**
 * When a message was written, for a hit of message search: the time on the day of the message,
 * otherwise the day and the time, with the year when the year is not this one.
 */
export const formatHitTime = (locale: Locale, at: number, now = Date.now()) => {
  const date = new Date(at)
  const today = new Date(now)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  if (sameDay) return formatTime(locale, at)
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at)
}

/**
 * How long ago something happened, in words of the language ("5 minutes ago", "3시간 전"). Less than
 * a minute reads as "now". The words come from the language, so no text is written here.
 */
export const formatSince = (locale: Locale, at: number, now = Date.now()) => {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return formatter.format(0, "second")
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return formatter.format(-minutes, "minute")
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return formatter.format(-hours, "hour")
  return formatter.format(-Math.floor(hours / 24), "day")
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
