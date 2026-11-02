import { Schema } from "effect"
import type { MessageKey } from "./i18n/index.ts"

export const EFFORTS = ["low", "medium", "high"] as const

/**
 * The effort levels of the current Claude models, as the Claude Code program takes them with its
 * effort flag. Opus, Sonnet and Haiku all take the five levels.
 */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

/**
 * Agent runtimes: the coding agent programs of the model vendors. The user signs in to them
 * with a subscription, so there is no key and no address.
 */
export const RUNTIME_KINDS = ["claude_code", "codex", "muse", "pi"] as const
export type RuntimeKind = (typeof RUNTIME_KINDS)[number]

export const ProviderKind = Schema.Literals(["openai", "anthropic", "custom", ...RUNTIME_KINDS])
export type ProviderKind = typeof ProviderKind.Type

export const isRuntimeKind = (kind: string): kind is RuntimeKind =>
  (RUNTIME_KINDS as readonly string[]).includes(kind)

export const defaultBaseUrls: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  custom: "",
  claude_code: "",
  codex: "",
  muse: "",
  pi: "",
}

/** One model account. Its key is in the system keychain, never here. */
export interface ProviderAccount {
  readonly id: string
  readonly kind: ProviderKind
  readonly name: string
  /** Empty for an agent runtime. */
  readonly baseUrl: string
  /**
   * An API account is connected when the app holds a key for it. A runtime account is connected
   * when the program is on the computer, the user is signed in with a subscription, and the
   * user did not disconnect the account.
   */
  readonly connected: boolean
  /** What the app knows about the vendor program. Only for a runtime account. */
  readonly runtime?: RuntimeStatus
}

export interface ModelInfo {
  readonly id: string
  readonly label: string
  /** Shown instead of `label` when set, so that it can be translated. */
  readonly labelKey?: MessageKey
  /** Effort levels the model takes. Empty when it has none. */
  readonly efforts: readonly string[]
}

/**
 * What the app does itself for a runtime. "download": the vendor publishes a file with a checksum
 * and the app fetches it. "manual": the user installs the program, or signs in inside it.
 */
export const runtimeSupport = (
  kind: RuntimeKind,
): { readonly install: "download" | "manual"; readonly signIn: "app" | "manual" } =>
  kind === "claude_code" || kind === "codex"
    ? { install: "download", signIn: "app" }
    : kind === "muse"
      ? { install: "manual", signIn: "app" }
      : { install: "manual", signIn: "manual" }

/** The usage window of a subscription, as the vendor reports it. */
export interface RuntimeLimit {
  /** For example "five_hour" or "seven_day". */
  readonly window: string
  /** 0 to 1. */
  readonly used: number
  /** When the window resets, in ms since the epoch. */
  readonly resetsAt: number | null
}

/** What the app knows about one vendor program on this computer. */
export interface RuntimeStatus {
  readonly kind: RuntimeKind
  /** Whose copy runs: the one the app downloaded, or one found on the computer. */
  readonly source: "app" | "system" | null
  readonly version: string | null
  readonly signedIn: boolean
  /** How the user is signed in. Only a subscription counts for an account. */
  readonly method: "subscription" | "api_key" | null
  /** The e-mail address of the sign-in, when the vendor tells it. */
  readonly user: string | null
  /** The plan name, for example "max". */
  readonly plan: string | null
  readonly busy: "installing" | "signing_in" | null
  /** 0 to 1 while installing; null when unknown. */
  readonly progress: number | null
  readonly limits: readonly RuntimeLimit[]
  /** When `limits` were read, in ms since the epoch. Null when they never were. */
  readonly limitsAt: number | null
  /** The last problem of the install or the sign-in, in plain words. */
  readonly problem: string | null
  /** While a sign-in waits for the user: the page to open, and the code to compare there. */
  readonly signInUrl: string | null
  readonly signInCode: string | null
}

/**
 * The models of a runtime that has a fixed set. The programs keep no list that the app can read,
 * except pi, whose list is asked from the program and is empty here.
 */
export const runtimeModels = (kind: RuntimeKind): readonly ModelInfo[] =>
  kind === "claude_code"
    ? [
        // The ids are the names that the program takes: each one means the newest model of its
        // kind. The labels give the version that Anthropic lists for each name today.
        { id: "opus", label: "Opus 5.5", efforts: CLAUDE_EFFORTS },
        { id: "sonnet", label: "Sonnet 5.5", efforts: CLAUDE_EFFORTS },
        { id: "haiku", label: "Haiku 5.5", efforts: CLAUDE_EFFORTS },
      ]
    : kind === "pi"
      ? []
      : [
          {
            id: "default",
            label: "Default",
            labelKey: "providers.model.default",
            efforts: EFFORTS,
          },
        ]

/**
 * A model that the app lists itself for a runtime, by its id. Models that the app has no list for
 * are not found; the caller then shows the id as it is.
 */
export const runtimeModel = (kind: ProviderKind | undefined, id: string): ModelInfo | undefined =>
  kind !== undefined && isRuntimeKind(kind)
    ? runtimeModels(kind).find((m) => m.id === id)
    : undefined

const HttpUrl = Schema.String.check(
  Schema.makeFilter((s: string) => {
    try {
      const url = new URL(s)
      return url.protocol === "https:" || url.protocol === "http:"
    } catch {
      return false
    }
  }),
)

/** `baseUrl` and `apiKey` are needed for an API account and ignored for a runtime. */
export const ProviderConnect = Schema.Struct({
  /** Give it to connect an existing account again. */
  accountId: Schema.optionalKey(Schema.String),
  kind: ProviderKind,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  baseUrl: Schema.optionalKey(HttpUrl),
  apiKey: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
})
export type ProviderConnect = typeof ProviderConnect.Type

/** Claude generation 5 and later, for example `claude-opus-5-5` or `claude-fable-5-1`. */
const CLAUDE_5_AND_LATER = /^claude-[a-z]+-(?:[5-9]|[1-9]\d)(?:-|$)/

/**
 * Claude models that think with a token budget and take no effort setting: Sonnet 4.5, Haiku 4.5,
 * Opus 4 and 4.1, Sonnet 4, and Claude 3.7. For these, the level of the picker sets the budget.
 */
export const takesThinkingBudget = (modelId: string): boolean => {
  const id = modelId.toLowerCase()
  return (
    /^claude-(?:sonnet-4-5|haiku-4-5|3-7-)/.test(id) ||
    /^claude-(?:opus|sonnet)-4(?:-[01])?(?:-\d{8}|-latest)?$/.test(id)
  )
}

/**
 * The effort levels that Anthropic documents for a Claude model id. The model list of the vendor
 * tells this too, and the app prefers it; this is for a list that does not.
 */
const claudeEfforts = (id: string): readonly string[] => {
  if (CLAUDE_5_AND_LATER.test(id) || /^claude-opus-4-[78](?:-|$)/.test(id)) return CLAUDE_EFFORTS
  if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(id)) return ["low", "medium", "high", "max"]
  if (/^claude-opus-4-5(?:-|$)/.test(id)) return EFFORTS
  if (takesThinkingBudget(id)) return EFFORTS
  return []
}

/** Effort levels for a model id, from what each vendor documents for its model families. */
export const effortsFor = (kind: ProviderKind, modelId: string): readonly string[] => {
  const id = modelId.toLowerCase()
  if (kind === "openai" && /^(o\d|gpt-5)/.test(id)) return EFFORTS
  if (kind === "anthropic") return claudeEfforts(id)
  return []
}

/**
 * Whether a Claude model id takes adaptive thinking. Then the effort level steers how much the
 * model thinks. Other models, and ids that the app does not know, get no thinking setting.
 */
export const takesAdaptiveThinking = (modelId: string): boolean => {
  const id = modelId.toLowerCase()
  return CLAUDE_5_AND_LATER.test(id) || /^claude-(?:opus|sonnet)-4-[678](?:-|$)/.test(id)
}
