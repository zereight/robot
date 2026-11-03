import { Schema } from "effect"
import { charLength } from "./agents.ts"
import type { MessageKey } from "./i18n/en.ts"

// The Teams link (spec 028): the pure rules of the form, the names and the states. Nothing here
// touches a page, a clock or a database.

/** The target of the link: the direct chat of one agent, or one channel. */
export const TEAMS_TARGET_KINDS = ["agent", "channel"] as const
export type TeamsTargetKind = (typeof TEAMS_TARGET_KINDS)[number]

/** "A chat with one person" (also the chat with oneself), or "A group chat". */
export const TEAMS_CHAT_KINDS = ["person", "group"] as const
export type TeamsChatKind = (typeof TEAMS_CHAT_KINDS)[number]

export const TEAMS_TITLE_MAX = 100
export const TEAMS_LIST_MAX = 20
export const TEAMS_NAME_MAX = 80
export const TEAMS_CALL_TEXT_MAX = 40
export const TEAMS_MARKER_MAX = 20
/** The marker of a new link. The user may change it while the switch is off. */
export const TEAMS_MARKER_DEFAULT = "[ROBot]"

/**
 * A request never carries more text than this in one field, so a huge paste is stopped before it
 * reaches the checks. The checks of the limits above run on the trimmed text.
 */
export const TEAMS_INPUT_MAX = 2000
export const TEAMS_LIST_INPUT_MAX = 200

/** Time between two looks at the chat while the link is on (spec 028, "Limits"). */
export const TEAMS_READ_MS = 3000
/** The state Connecting lasts at most this long. */
export const TEAMS_CONNECT_MAX_MS = 60_000
/** Chat not found and Offline look again after this time. */
export const TEAMS_LOOK_AGAIN_MS = 30_000

/**
 * The states that the first slice (S101) shows. The state Paused (repeated failure) comes with the
 * slice that brings the pause (S105).
 */
export const TEAMS_STATES = [
  "off",
  "connecting",
  "on",
  "signedOut",
  "chatNotFound",
  "offline",
  "targetMissing",
] as const
export type TeamsState = (typeof TEAMS_STATES)[number]

/** Why the chat is not found: no chat holds the title, or more than one does. */
export type TeamsChatMatch = "none" | "many"

/** The fields of the form. The sign-in is not a field, but the switch checks it too. */
export interface TeamsFields {
  readonly targetKind: TeamsTargetKind | null
  readonly targetId: string | null
  readonly chatTitle: string
  readonly chatKind: TeamsChatKind
  readonly allow: readonly string[]
  readonly bots: readonly string[]
  readonly callText: string
  readonly marker: string
}

export const emptyTeamsFields: TeamsFields = {
  targetKind: null,
  targetId: null,
  chatTitle: "",
  chatKind: "person",
  allow: [],
  bots: [],
  callText: "",
  marker: TEAMS_MARKER_DEFAULT,
}

/** What the window may change in one request. Each field is optional. */
export const TeamsPatch = Schema.Struct({
  targetKind: Schema.optionalKey(Schema.NullOr(Schema.Literals(TEAMS_TARGET_KINDS))),
  targetId: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(200)))),
  chatTitle: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(TEAMS_INPUT_MAX))),
  chatKind: Schema.optionalKey(Schema.Literals(TEAMS_CHAT_KINDS)),
  allow: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(TEAMS_INPUT_MAX))).check(
      Schema.isMaxLength(TEAMS_LIST_INPUT_MAX),
    ),
  ),
  bots: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(TEAMS_INPUT_MAX))).check(
      Schema.isMaxLength(TEAMS_LIST_INPUT_MAX),
    ),
  ),
  callText: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(TEAMS_INPUT_MAX))),
  marker: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(TEAMS_INPUT_MAX))),
})
export type TeamsPatch = typeof TeamsPatch.Type

/** The fields that change only while the switch is off (spec 028, "Other controls"). */
export const TEAMS_LOCKED_FIELDS = [
  "targetKind",
  "targetId",
  "chatTitle",
  "chatKind",
  "marker",
] as const

/** True when the patch changes a field that the switch locks. */
export const patchTouchesLocked = (patch: TeamsPatch, now: TeamsFields): boolean =>
  TEAMS_LOCKED_FIELDS.some((field) => field in patch && patch[field] !== now[field])

// --- Names -------------------------------------------------------------------------------

/**
 * The key of a name: the name as Teams shows it, with the spaces at both ends removed, runs of
 * spaces joined, and letter case ignored. Two names are the same when their keys are equal.
 */
export const teamsNameKey = (name: string): string =>
  name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase()

export const sameTeamsName = (a: string, b: string): boolean => teamsNameKey(a) === teamsNameKey(b)

/**
 * The names of a typed list: spaces at both ends removed, empty lines dropped, and a name that
 * repeats an earlier one dropped. Limits are not applied here: the check of the form says if a
 * name is too long or the list too long.
 */
export const cleanNames = (names: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, " ")
    const key = teamsNameKey(name)
    if (key === "" || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** The names of a text with one name on each line. */
export const namesOfText = (text: string): string[] => cleanNames(text.split(/\r?\n/))

/** True when a name is on both lists. The bot list wins, and the form says so. */
export const botListWins = (allow: readonly string[], bots: readonly string[]): boolean => {
  const keys = new Set(bots.map(teamsNameKey))
  return allow.some((name) => keys.has(teamsNameKey(name)))
}

/**
 * True when the title of a chat holds the text of the link (spec 028, "Chat title"). The compare
 * treats spaces and letter case as it does for names. An empty text holds nothing.
 */
export const holdsChatTitle = (title: string, wanted: string): boolean => {
  const key = teamsNameKey(wanted)
  return key !== "" && teamsNameKey(title).includes(key)
}

// --- The form checks ---------------------------------------------------------------------

/** The fields that carry a reason under them. */
export type TeamsFieldName =
  | "signIn"
  | "target"
  | "chatTitle"
  | "allow"
  | "bots"
  | "callText"
  | "marker"

/** The reasons that the switch refuses with. Each shows under its field. */
export const TEAMS_PROBLEMS = [
  "noSignIn",
  "noTarget",
  "targetMissing",
  "titleEmpty",
  "titleLong",
  "allowEmpty",
  "allowMany",
  "allowNameLong",
  "botsMany",
  "botsNameLong",
  "callMissing",
  "callLong",
  "markerEmpty",
  "markerLong",
] as const
export type TeamsProblem = (typeof TEAMS_PROBLEMS)[number]

const FIELD_OF: Record<TeamsProblem, TeamsFieldName> = {
  noSignIn: "signIn",
  noTarget: "target",
  targetMissing: "target",
  titleEmpty: "chatTitle",
  titleLong: "chatTitle",
  allowEmpty: "allow",
  allowMany: "allow",
  allowNameLong: "allow",
  botsMany: "bots",
  botsNameLong: "bots",
  callMissing: "callText",
  callLong: "callText",
  markerEmpty: "marker",
  markerLong: "marker",
}

/** The field that a reason shows under. */
export const problemField = (problem: TeamsProblem): TeamsFieldName => FIELD_OF[problem]

/** The problems that are a limit. They show at once; the others show after the switch refuses. */
export const isLimitProblem = (problem: TeamsProblem): boolean => /Long$|Many$/.test(problem)

/** What the check needs to know besides the form. */
export interface TeamsCheckContext {
  /** The Teams page showed Teams, not a sign-in form, the last time it was looked at. */
  readonly signedIn: boolean
  /** The target exists and is not archived. */
  readonly targetFound: boolean
}

/**
 * Checks the form for the switch. Returns every reason that stops it, in the order of the form.
 * An empty list means the switch may turn on.
 */
export const checkTeamsLink = (fields: TeamsFields, context: TeamsCheckContext): TeamsProblem[] => {
  const problems: TeamsProblem[] = []
  if (!context.signedIn) problems.push("noSignIn")
  if (fields.targetKind === null || fields.targetId === null) problems.push("noTarget")
  else if (!context.targetFound) problems.push("targetMissing")
  const titleLength = charLength(fields.chatTitle.trim())
  if (titleLength < 1) problems.push("titleEmpty")
  else if (titleLength > TEAMS_TITLE_MAX) problems.push("titleLong")
  const allow = cleanNames(fields.allow)
  if (allow.length < 1) problems.push("allowEmpty")
  if (allow.length > TEAMS_LIST_MAX) problems.push("allowMany")
  if (allow.some((name) => charLength(name) > TEAMS_NAME_MAX)) problems.push("allowNameLong")
  const bots = cleanNames(fields.bots)
  if (bots.length > TEAMS_LIST_MAX) problems.push("botsMany")
  if (bots.some((name) => charLength(name) > TEAMS_NAME_MAX)) problems.push("botsNameLong")
  const call = fields.callText.trim()
  if (call === "" && fields.chatKind === "group") problems.push("callMissing")
  if (charLength(call) > TEAMS_CALL_TEXT_MAX) problems.push("callLong")
  const markerLength = charLength(fields.marker.trim())
  if (markerLength < 1) problems.push("markerEmpty")
  else if (markerLength > TEAMS_MARKER_MAX) problems.push("markerLong")
  return problems
}

/** The fields as the link keeps them: trimmed, with clean lists. */
export const tidyTeamsFields = (fields: TeamsFields): TeamsFields => ({
  ...fields,
  chatTitle: fields.chatTitle.trim(),
  allow: cleanNames(fields.allow),
  bots: cleanNames(fields.bots),
  callText: fields.callText.trim(),
  marker: fields.marker.trim(),
})

// --- The view of the link ----------------------------------------------------------------

/** What the window sees of the Teams link. A linked device never gets it (spec 028, "Surfaces"). */
export interface TeamsLinkView {
  /** The user pressed "Set up": the link exists, with its form. */
  readonly exists: boolean
  readonly fields: TeamsFields
  /** The switch. */
  readonly enabled: boolean
  readonly state: TeamsState
  /** With the state Chat not found: no chat, or more than one chat, holds the title. */
  readonly chat: TeamsChatMatch | null
  /** The Teams page showed Teams, not a sign-in form, the last time it was looked at. */
  readonly signedIn: boolean
  /** Time of the last good look at the chat, or null. */
  readonly lastReadAt: number | null
  /** The user asked to see the Teams page. */
  readonly pageShown: boolean
  /** What stops the switch now, in the order of the form. */
  readonly problems: readonly TeamsProblem[]
  /** A name is on both lists: the bot list wins. */
  readonly botListWins: boolean
  /** The browser profile that holds the sign-in, or null before the first sign-in. */
  readonly signInProfileId: string | null
}

export const emptyTeamsView: TeamsLinkView = {
  exists: false,
  fields: emptyTeamsFields,
  enabled: false,
  state: "off",
  chat: null,
  signedIn: false,
  lastReadAt: null,
  pageShown: false,
  problems: [],
  botListWins: false,
  signInProfileId: null,
}

/** The state that the header mark names. Only a link that is on has a mark (spec 028). */
export const teamsMarkShows = (view: TeamsLinkView): boolean => view.exists && view.enabled

/** True when the link is for this agent or this channel. */
export const teamsLinksTo = (view: TeamsLinkView, kind: TeamsTargetKind, id: string): boolean =>
  view.exists && view.fields.targetKind === kind && view.fields.targetId === id

// --- What the page shows -----------------------------------------------------------------

/** What the Teams page shows now. */
export type TeamsLook =
  /** The page cannot reach Microsoft. */
  | { readonly kind: "offline" }
  /** The page shows a sign-in form. */
  | { readonly kind: "signIn" }
  /** The page shows Teams. `openTitle` is the title of the open chat, or null. */
  | { readonly kind: "teams"; readonly openTitle: string | null }
  /** The page is open but shows neither: it still loads, or Teams changed its page. */
  | { readonly kind: "unreadable" }

/** The result of "open the chat that holds the title". */
export type TeamsChatOpened =
  | { readonly kind: "opened"; readonly title: string }
  | { readonly kind: "none" }
  | { readonly kind: "many" }

/**
 * Picks the chat to open from the titles in the chat list and the title of the open chat. Exactly
 * one chat must hold the text: none, or more than one, is not a match. When the list shows no
 * chat that holds the text but the open chat does, the open chat is the one match.
 */
export const pickChat = (
  listTitles: readonly string[],
  openTitle: string | null,
  wanted: string,
):
  | { readonly kind: "one"; readonly index: number | null; readonly title: string }
  | { readonly kind: "none" | "many" } => {
  const hits: { index: number; title: string }[] = []
  listTitles.forEach((title, index) => {
    if (holdsChatTitle(title, wanted)) hits.push({ index, title })
  })
  if (hits.length > 1) return { kind: "many" }
  const only = hits[0]
  if (only) return { kind: "one", index: only.index, title: only.title }
  if (openTitle !== null && holdsChatTitle(openTitle, wanted))
    return { kind: "one", index: null, title: openTitle }
  return { kind: "none" }
}

// --- The words ---------------------------------------------------------------------------

/** The nine facts of the page text, in order (spec 028, "Page text"). */
export const TEAMS_FACT_KEYS = [
  "teams.intro",
  "teams.fact.service",
  "teams.fact.rules",
  "teams.fact.password",
  "teams.fact.names",
  "teams.fact.permission",
  "teams.fact.read",
  "teams.fact.computers",
  "teams.fact.off",
] as const satisfies readonly MessageKey[]

/** The dialog of "Turn on" repeats the second, the third and the sixth fact. */
export const TEAMS_DIALOG_FACT_KEYS = [
  TEAMS_FACT_KEYS[1],
  TEAMS_FACT_KEYS[2],
  TEAMS_FACT_KEYS[5],
] as const

/** The text of a state in Settings, Teams (not for the state On, which needs the title and time). */
export const teamsStateTextKey = (
  state: Exclude<TeamsState, "on">,
  chat: TeamsChatMatch | null,
): MessageKey => {
  switch (state) {
    case "off":
      return "teams.state.off"
    case "connecting":
      return "teams.state.connecting"
    case "signedOut":
      return "teams.state.signedOut"
    case "chatNotFound":
      return chat === "many" ? "teams.state.chatMany" : "teams.state.chatNone"
    case "offline":
      return "teams.state.offline"
    case "targetMissing":
      return "teams.state.targetMissing"
  }
}

/** The short state word of the header mark. The state On has none (spec 028). */
export const teamsStateWordKey = (state: TeamsState): MessageKey | null => {
  switch (state) {
    case "off":
    case "on":
      return null
    case "connecting":
      return "teams.stateWord.connecting"
    case "signedOut":
      return "teams.stateWord.signedOut"
    case "chatNotFound":
      return "teams.stateWord.chatNotFound"
    case "offline":
      return "teams.stateWord.offline"
    case "targetMissing":
      return "teams.stateWord.targetMissing"
  }
}
