import type { WireNotice } from "@robot/link"
import { type PhoneStorage, readJson } from "@robot/phone"
import type { LanguageChoice } from "./i18n/index.ts"

export type ThemeChoice = "system" | "dark" | "light"

/** The kinds of notification of spec 011. "approval" covers approval and question cards. */
export const NOTIFY_KINDS = ["reply", "mention", "approval", "task_failed"] as const
export type NotifyKind = (typeof NOTIFY_KINDS)[number]

/** The settings of this phone. They stay on the phone and never go to a computer. */
export interface Prefs {
  readonly language: LanguageChoice
  readonly theme: ThemeChoice
  readonly notify: Readonly<Record<NotifyKind, boolean>>
  /** The sections that the user closed, per paired server: keys like "agents" or "user:<id>". */
  readonly closed: Readonly<Record<string, readonly string[]>>
  /** When false, finished plain tool steps fold into one line per run. */
  readonly showToolSteps: boolean
}

export const defaultPrefs: Prefs = {
  language: "system",
  theme: "system",
  notify: { reply: true, mention: true, approval: true, task_failed: true },
  closed: {},
  showToolSteps: true,
}

const PREFS_FILE = "prefs.json"

const oneOf = <T extends string>(value: unknown, list: readonly T[], fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback

/** Reads the settings. A bad or missing value gives its default. */
export const readPrefs = async (storage: PhoneStorage): Promise<Prefs> => {
  const raw = await readJson<Record<string, unknown>>(storage, PREFS_FILE, {})
  const notify = (raw.notify ?? {}) as Record<string, unknown>
  const closed = (raw.closed ?? {}) as Record<string, unknown>
  return {
    language: oneOf(raw.language, ["system", "en", "ko"], "system"),
    theme: oneOf(raw.theme, ["system", "dark", "light"], "system"),
    showToolSteps: typeof raw.showToolSteps === "boolean" ? raw.showToolSteps : true,
    notify: Object.fromEntries(
      NOTIFY_KINDS.map((k) => [k, typeof notify[k] === "boolean" ? notify[k] : true]),
    ) as Record<NotifyKind, boolean>,
    closed: Object.fromEntries(
      Object.entries(closed).flatMap(([k, v]) =>
        Array.isArray(v) ? [[k, v.filter((x): x is string => typeof x === "string")]] : [],
      ),
    ),
  }
}

export const writePrefs = (storage: PhoneStorage, prefs: Prefs) =>
  storage.write(PREFS_FILE, JSON.stringify(prefs))

/** The setting that turns a notice on or off. Kinds that Phone 1 does not show give null. */
export const notifyKindOf = (notice: Pick<WireNotice, "kind">): NotifyKind | null => {
  switch (notice.kind) {
    case "reply":
    case "mention":
    case "task_failed":
      return notice.kind
    case "approval":
    case "question":
      return "approval"
    default:
      return null
  }
}

/** Whether the phone shows a notice as a notification, by the settings of the user. */
export const shouldNotify = (prefs: Prefs, notice: Pick<WireNotice, "kind">) => {
  const kind = notifyKindOf(notice)
  return kind !== null && prefs.notify[kind]
}

/** Opens or closes a section of a server, and returns the new settings. */
export const toggleSection = (prefs: Prefs, linkId: string, key: string): Prefs => {
  const list = prefs.closed[linkId] ?? []
  const next = list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
  return { ...prefs, closed: { ...prefs.closed, [linkId]: next } }
}

/** Forgets what the phone remembered of a server, after an unpair. */
export const forgetServer = (prefs: Prefs, linkId: string): Prefs => {
  const { [linkId]: _gone, ...rest } = prefs.closed
  return { ...prefs, closed: rest }
}
