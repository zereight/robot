import {
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  type AgentModel,
  charLength,
  FACE_HUES,
  FACE_SHAPES,
  type Face,
} from "./agents.ts"
import type { ModelInfo } from "./providers.ts"
import type { Settings } from "./settings.ts"

// ---------------------------------------------------------------------------------------------
// Instruction history (spec 002, "Instruction history")
// ---------------------------------------------------------------------------------------------

/** Where a change of the instructions came from. */
export const INSTRUCTION_SOURCES = ["profile", "chat", "device", "undo", "restore"] as const
export type InstructionSource = (typeof INSTRUCTION_SOURCES)[number]

/** An agent keeps at most this many versions. The oldest goes first. */
export const INSTRUCTION_HISTORY_MAX = 50

/** One version of the instructions: the text that a change set, when, and where it came from. */
export interface InstructionVersion {
  readonly id: string
  readonly agentId: string
  readonly text: string
  readonly source: InstructionSource
  readonly createdAt: number
}

// ---------------------------------------------------------------------------------------------
// Changes from the chat (spec 002, "Changes from the chat")
// ---------------------------------------------------------------------------------------------

/** The fields of itself that an agent may change. `model` holds the account, model and effort. */
export const AGENT_SETTING_FIELDS = ["name", "role", "instructions", "face", "model"] as const
/** The settings of the app that an agent may read and change (spec 013). */
export const APP_SETTING_FIELDS = [
  "language",
  "theme",
  "textSize",
  "compactPlaces",
  "reduceMotion",
] as const
export type AgentSettingField = (typeof AGENT_SETTING_FIELDS)[number]
export type AppSettingField = (typeof APP_SETTING_FIELDS)[number]
export type SettingField = AgentSettingField | AppSettingField

export type SettingValue = string | boolean | Face | AgentModel | null

/** One field that a call of the settings tool changed, with the value before and after. */
export interface SettingChange {
  readonly field: SettingField
  readonly before: SettingValue
  readonly after: SettingValue
}

/**
 * What one call of the settings tool changed. The chat shows it as a muted line with Undo.
 * `versionId` is the version of the instructions that the call made, when it changed them.
 * `undone` is set when the user pressed Undo.
 */
export interface SettingsNote {
  readonly changes: readonly SettingChange[]
  readonly versionId?: string
  readonly undone?: boolean
}

/** The state of the Undo of a settings line. */
export type SettingsLineState = "ready" | "undone" | "changed"

export const isAppSettingField = (field: string): field is AppSettingField =>
  (APP_SETTING_FIELDS as readonly string[]).includes(field)

/** The values that the app settings may take, by field. */
export const APP_SETTING_VALUES = {
  language: ["system", "en", "ko"],
  theme: ["system", "dark", "light"],
  textSize: ["small", "default", "large"],
  reduceMotion: ["system", "on", "off"],
} as const satisfies Record<Exclude<AppSettingField, "compactPlaces">, readonly string[]>

/**
 * Where the user changes a thing that the agent may not change. The agent reads this text and
 * tells the user. The interface never shows it.
 */
export type ProtectedPlace =
  | "permission"
  | "rules"
  | "workspace"
  | "computer_use"
  | "main_agent"
  | "memory"
  | "connections"
  | "skills"
  | "secrets"
  | "sync"
  | "devices"
  | "archive"
  | "other_agent"
  | "teams"

export const PROTECTED_PLACES: Readonly<Record<ProtectedPlace, string>> = {
  permission: "The permission level: the user changes it in the profile of the agent.",
  rules: "The permission rules: the user changes them in Settings → Permissions.",
  workspace: "The workspace folder: only the user decides it.",
  computer_use: "Computer use: the user turns it on in Settings.",
  main_agent: "The main agent switch: the user turns it on in the profile of the agent.",
  memory:
    "The memory switch and how memory saves (at once or ask first): the user changes them in the profile of the agent.",
  connections: "Connections: the user manages them in Settings → Connections.",
  skills: "Skills: the user manages them in Settings → Skills.",
  secrets: "Saved secrets: the user manages them in Settings → Permissions.",
  sync: "Sync: the user manages it in Settings → Devices.",
  devices: "Devices: the user manages them in Settings → Devices.",
  archive:
    "Archive and delete: the user archives an agent in its profile, and deletes it in Settings → Archive.",
  other_agent: "Other agents: the user changes them in their own profiles.",
  teams: "The Teams link: the user turns it on or off in Settings → Teams.",
}

/** The names that a model may give to a protected thing, and the place for each. */
const PROTECTED_NAMES: Readonly<Record<string, ProtectedPlace>> = {
  permission: "permission",
  permission_level: "permission",
  permissions: "permission",
  level: "permission",
  rules: "rules",
  rule: "rules",
  allow: "rules",
  deny: "rules",
  workspace: "workspace",
  workspace_folder: "workspace",
  folder: "workspace",
  computer_use: "computer_use",
  main_agent: "main_agent",
  main: "main_agent",
  memory: "memory",
  memory_enabled: "memory",
  use_memory: "memory",
  memory_mode: "memory",
  save_memory: "memory",
  connections: "connections",
  connection: "connections",
  skills: "skills",
  skill: "skills",
  secrets: "secrets",
  saved_secrets: "secrets",
  secret: "secrets",
  sync: "sync",
  devices: "devices",
  device: "devices",
  archive: "archive",
  archived: "archive",
  delete: "archive",
  agent: "other_agent",
  agent_id: "other_agent",
  other_agent: "other_agent",
  target: "other_agent",
  teams: "teams",
  teams_link: "teams",
  link: "teams",
  chat_bridge: "teams",
  bridge: "teams",
}

/** The names of the arguments of the settings tool. */
export const SETTINGS_TOOL_ARGS = [
  "name",
  "role",
  "instructions",
  "face_shape",
  "face_hue",
  "account",
  "model",
  "effort",
  "language",
  "theme",
  "text_size",
  "compact_place_list",
  "reduce_motion",
] as const

/** A connected model account and its models, as the settings tool offers them. */
export interface SettingsAccount {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelInfo[]
}

/** A model that a loose name matched. */
export interface ModelMatch {
  readonly accountId: string
  readonly accountName: string
  readonly model: ModelInfo
}

/** Words that say nothing about which model: "use the newest Sonnet model". */
const FILLER = new Set([
  "the",
  "a",
  "an",
  "model",
  "models",
  "newest",
  "latest",
  "new",
  "newer",
  "best",
  "use",
  "to",
  "switch",
  "please",
  "version",
  "one",
])

/** Letters and digits only, in lower case. */
const compact = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

/** The account that a loose name means, by id or by name. Undefined when none or several match. */
export const matchAccount = (
  query: string,
  accounts: readonly SettingsAccount[],
): SettingsAccount | undefined => {
  const q = compact(query)
  if (!q) return undefined
  const exact = accounts.filter((a) => a.id === query || compact(a.name) === q)
  if (exact.length === 1) return exact[0]
  const loose = accounts.filter((a) => compact(a.name).includes(q))
  return loose.length === 1 ? loose[0] : undefined
}

/**
 * The models of the connected accounts that a loose name matches (spec 002). A name that equals
 * the id or the label of a model matches only those. Otherwise each word of the name (filler words
 * left out), in letters and digits only, must be in the id or the label. The caller changes nothing unless one model matches.
 */
export const matchModels = (
  query: string,
  accounts: readonly SettingsAccount[],
): readonly ModelMatch[] => {
  const all = accounts.flatMap((a) =>
    a.models.map((model) => ({ accountId: a.id, accountName: a.name, model })),
  )
  const q = compact(query)
  if (!q) return []
  const exact = all.filter((m) => compact(m.model.id) === q || compact(m.model.label) === q)
  if (exact.length > 0) return exact
  // A word keeps its digits together: "4.5" is "45", so it does not match "3-5".
  const words = query
    .split(/\s+/u)
    .map(compact)
    .filter((w) => w && !FILLER.has(w))
  if (words.length === 0) return []
  return all.filter((m) => {
    const text = `${compact(m.model.id)} ${compact(m.model.label)}`
    return words.every((w) => text.includes(w))
  })
}

/** What the settings tool knows when it plans a call. */
export interface SettingsCurrent {
  readonly name: string
  readonly role: string
  readonly instructions: string
  readonly face: Face
  readonly model: AgentModel | null
  readonly app: Pick<Settings, AppSettingField>
}

export type SettingsPlan =
  /** A call with no change: the agent gets the current and the allowed values. */
  | { readonly kind: "read" }
  /** Every value is the value that is set already. */
  | { readonly kind: "unchanged" }
  /** Nothing changes, and the agent reads why. */
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "changes"; readonly changes: readonly SettingChange[] }

const listModels = (matches: readonly ModelMatch[]) =>
  matches.map((m) => `- ${m.model.id} (${m.model.label}) on the account "${m.accountName}"`)

const sameValue = (a: SettingValue, b: SettingValue) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Plans a call of the settings tool. It checks every value as the profile form does and changes
 * nothing when one value is wrong. `nameTaken` tells whether another agent on the server has the
 * name. `effortsOf` gives the effort levels of a model of an account.
 */
export const planSettings = (
  args: Readonly<Record<string, unknown>>,
  current: SettingsCurrent,
  accounts: readonly SettingsAccount[],
  nameTaken: (name: string) => boolean,
  effortsOf: (accountId: string, model: string) => readonly string[],
): SettingsPlan => {
  const given = Object.entries(args).filter(([, v]) => v !== undefined && v !== null)
  if (given.length === 0) return { kind: "read" }
  // A thing that the agent may not change refuses the whole call, and says where the user goes.
  const places = new Set<ProtectedPlace>()
  const unknown: string[] = []
  for (const [key] of given) {
    const place = PROTECTED_NAMES[key.toLowerCase()]
    if (place) places.add(place)
    else if (!(SETTINGS_TOOL_ARGS as readonly string[]).includes(key)) unknown.push(key)
  }
  if (places.size > 0)
    return {
      kind: "refused",
      reason: [
        "Nothing changed. You cannot change this. Tell the user where to change it:",
        ...[...places].map((p) => `- ${PROTECTED_PLACES[p]}`),
      ].join("\n"),
    }
  if (unknown.length > 0)
    return {
      kind: "refused",
      reason: `Nothing changed. Unknown fields: ${unknown.join(", ")}. Call the tool with no fields to see what you can change.`,
    }
  const refuse = (reason: string): SettingsPlan => ({
    kind: "refused",
    reason: `Nothing changed. ${reason}`,
  })
  const changes: SettingChange[] = []
  const add = (field: SettingField, before: SettingValue, after: SettingValue) => {
    if (!sameValue(before, after)) changes.push({ field, before, after })
  }
  const text = (key: string): string | undefined => {
    const v = args[key]
    return typeof v === "string" ? v : undefined
  }

  if (args.name !== undefined && args.name !== null) {
    const name = text("name")?.trim()
    if (name === undefined || charLength(name) < 1 || charLength(name) > AGENT_NAME_MAX)
      return refuse(`A name has 1 to ${AGENT_NAME_MAX} characters.`)
    if (name !== current.name && nameTaken(name))
      return refuse("Another agent on this server has this name.")
    add("name", current.name, name)
  }
  if (args.role !== undefined && args.role !== null) {
    const role = text("role")?.trim()
    if (role === undefined || charLength(role) > AGENT_ROLE_MAX)
      return refuse(`A role line has at most ${AGENT_ROLE_MAX} characters.`)
    add("role", current.role, role)
  }
  if (args.instructions !== undefined && args.instructions !== null) {
    const instructions = text("instructions")
    if (instructions === undefined) return refuse("The instructions must be text.")
    add("instructions", current.instructions, instructions)
  }
  const shapeArg = args.face_shape
  const hueArg = args.face_hue
  if ((shapeArg ?? null) !== null || (hueArg ?? null) !== null) {
    const pick = (v: unknown, max: number, fallback: number) => {
      if (v === undefined || v === null) return fallback
      return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max
        ? (v as number) - 1
        : undefined
    }
    const shape = pick(shapeArg, FACE_SHAPES, current.face.shape)
    const hue = pick(hueArg, FACE_HUES, current.face.hue)
    if (shape === undefined) return refuse(`The face shape is a number from 1 to ${FACE_SHAPES}.`)
    if (hue === undefined) return refuse(`The face hue is a number from 1 to ${FACE_HUES}.`)
    add("face", current.face, { shape, hue })
  }

  // The model: the account, the model and the effort are one field.
  const accountArg = text("account")
  const modelArg = text("model")
  const effortArg = text("effort")
  if (
    (args.account ?? null) !== null ||
    (args.model ?? null) !== null ||
    (args.effort ?? null) !== null
  ) {
    if ((args.account ?? null) !== null && !accountArg) return refuse("The account must be text.")
    if ((args.model ?? null) !== null && !modelArg) return refuse("The model must be text.")
    if ((args.effort ?? null) !== null && !effortArg) return refuse("The effort must be text.")
    let pool = accounts
    if (accountArg) {
      const account = matchAccount(accountArg, accounts)
      if (!account)
        return refuse(
          [
            `No single connected account matches "${accountArg}". Ask the user which one. The connected accounts:`,
            ...accounts.map((a) => `- ${a.name}`),
          ].join("\n"),
        )
      pool = [account]
    }
    let next: AgentModel | null = current.model
    if (modelArg) {
      const matches = matchModels(modelArg, pool)
      if (matches.length !== 1) {
        const all = pool.flatMap((a) =>
          a.models.map((model) => ({ accountId: a.id, accountName: a.name, model })),
        )
        return refuse(
          [
            matches.length === 0
              ? `No connected model matches "${modelArg}". Ask the user which model to use. The models:`
              : `More than one model matches "${modelArg}". Ask the user which one. The models that match:`,
            ...listModels(matches.length === 0 ? all : matches),
          ].join("\n"),
        )
      }
      const match = matches[0] as ModelMatch
      next = {
        accountId: match.accountId,
        model: match.model.id,
        effort: current.model?.effort ?? null,
      }
    } else if (accountArg) {
      // Only the account: the same model on the other account.
      const account = pool[0] as SettingsAccount
      const same = current.model
        ? account.models.find((m) => m.id === current.model?.model)
        : undefined
      if (!same)
        return refuse(
          [
            `The account "${account.name}" does not have the model of this agent. Name a model too. Its models:`,
            ...listModels(
              account.models.map((model) => ({
                accountId: account.id,
                accountName: account.name,
                model,
              })),
            ),
          ].join("\n"),
        )
      next = { accountId: account.id, model: same.id, effort: current.model?.effort ?? null }
    }
    if (!next) return refuse("This agent has no model. Name a model.")
    const offered = effortsOf(next.accountId, next.model)
    if (effortArg) {
      if (!offered.includes(effortArg))
        return refuse(
          offered.length === 0
            ? `The model ${next.model} has no effort levels.`
            : `The model ${next.model} takes these effort levels: ${offered.join(", ")}.`,
        )
      next = { ...next, effort: effortArg }
    } else if (next.effort !== null && !offered.includes(next.effort)) {
      // The new model does not take the old level: the agent uses the default of the model.
      next = { ...next, effort: null }
    }
    add("model", current.model, next)
  }

  // The app settings (spec 013).
  const appArgs: [string, AppSettingField][] = [
    ["language", "language"],
    ["theme", "theme"],
    ["text_size", "textSize"],
    ["reduce_motion", "reduceMotion"],
  ]
  for (const [key, field] of appArgs) {
    const v = args[key]
    if (v === undefined || v === null) continue
    const allowed = APP_SETTING_VALUES[
      field as keyof typeof APP_SETTING_VALUES
    ] as readonly string[]
    if (typeof v !== "string" || !allowed.includes(v))
      return refuse(`The value of ${key} is one of: ${allowed.join(", ")}.`)
    add(field, current.app[field], v)
  }
  if (args.compact_place_list !== undefined && args.compact_place_list !== null) {
    if (typeof args.compact_place_list !== "boolean")
      return refuse("compact_place_list is true or false.")
    add("compactPlaces", current.app.compactPlaces, args.compact_place_list)
  }
  return changes.length === 0 ? { kind: "unchanged" } : { kind: "changes", changes }
}

/** The text that the agent reads for a call with no change: the values now and the choices. */
export const describeSettings = (
  current: SettingsCurrent,
  accounts: readonly SettingsAccount[],
): string => {
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? "not connected"
  const model = current.model
  const lines = [
    "Your settings now:",
    `- name: ${current.name}`,
    `- role: ${current.role || "(none)"}`,
    `- face_shape: ${current.face.shape + 1} (1 to ${FACE_SHAPES}), face_hue: ${current.face.hue + 1} (1 to ${FACE_HUES})`,
    model
      ? `- model: ${model.model} on the account "${accountName(model.accountId)}", effort: ${model.effort ?? "default"}`
      : "- model: none",
    `- instructions: ${current.instructions ? `${charLength(current.instructions)} characters` : "(none)"}`,
    "",
    "The app settings now:",
    `- language: ${current.app.language} (${APP_SETTING_VALUES.language.join(", ")})`,
    `- theme: ${current.app.theme} (${APP_SETTING_VALUES.theme.join(", ")})`,
    `- text_size: ${current.app.textSize} (${APP_SETTING_VALUES.textSize.join(", ")})`,
    `- compact_place_list: ${current.app.compactPlaces} (true, false)`,
    `- reduce_motion: ${current.app.reduceMotion} (${APP_SETTING_VALUES.reduceMotion.join(", ")})`,
    "",
    "The connected accounts and their models:",
    ...accounts.flatMap((a) => [
      `- account "${a.name}":`,
      ...(a.models.length === 0 ? ["  (no models listed)"] : []),
      ...a.models.map(
        (m) =>
          `  - ${m.id} (${m.label})${m.efforts.length > 0 ? `, effort: ${m.efforts.join(", ")}` : ""}`,
      ),
    ]),
    "",
    "You cannot change these. When the user asks, say where they change them:",
    ...Object.values(PROTECTED_PLACES).map((p) => `- ${p}`),
  ]
  return lines.join("\n")
}

/** A short text of one change, for the approval card and the action log. */
export const changeSummary = (changes: readonly SettingChange[]): string =>
  changes
    .map((c) => {
      const value = (v: SettingValue) => {
        if (v === null) return "none"
        if (typeof v === "string")
          return c.field === "instructions" ? `${charLength(v)} characters` : v
        if (typeof v === "boolean") return v ? "on" : "off"
        if ("model" in v) return v.effort ? `${v.model} (${v.effort})` : v.model
        return `shape ${v.shape + 1}, hue ${v.hue + 1}`
      }
      return c.field === "instructions"
        ? `instructions: ${typeof c.after === "string" ? c.after : ""}`
        : `${c.field}: ${value(c.before)} → ${value(c.after)}`
    })
    .join("; ")
