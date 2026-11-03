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
export const RUNTIME_KINDS = ["claude_code", "codex", "muse", "pi", "opencode"] as const
export type RuntimeKind = (typeof RUNTIME_KINDS)[number]

export const ProviderKind = Schema.Literals(["openai", "anthropic", "custom", ...RUNTIME_KINDS])
export type ProviderKind = typeof ProviderKind.Type

export const isRuntimeKind = (kind: string): kind is RuntimeKind =>
  (RUNTIME_KINDS as readonly string[]).includes(kind)

/**
 * True when the program reads a message of the user in the middle of a turn, as the app runs it
 * (spec 003). Claude Code reads a stream of messages on its input (`--input-format stream-json`).
 * Codex (`exec`), Muse Code, pi and opencode get one prompt when they start.
 */
export const runtimeTakesInput = (kind: RuntimeKind): boolean => kind === "claude_code"

export const defaultBaseUrls: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  custom: "",
  claude_code: "",
  codex: "",
  muse: "",
  pi: "",
  opencode: "",
}

/**
 * The name of a separate sign-in. The app keeps one folder for each in its data folder, so the id
 * is also a folder name: it holds only letters, digits and dashes.
 */
export const SIGN_IN_ID = /^[A-Za-z0-9-]{8,64}$/

/**
 * Whether the user can keep more than one sign-in of this program. An account of such a kind can
 * have a sign-in of its own, apart from the one of the program on this computer.
 */
export const runtimeHasSeparateSignIn = (kind: ProviderKind): boolean => kind === "claude_code"

/** One model account. Its key is in the system keychain, never here. */
export interface ProviderAccount {
  readonly id: string
  readonly kind: ProviderKind
  readonly name: string
  /** Empty for an agent runtime. */
  readonly baseUrl: string
  /**
   * The id of the separate sign-in of this account (see `SIGN_IN_ID`). Null when the account uses
   * the sign-in that the program has on this computer, and for an API account.
   */
  readonly signIn: string | null
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

/**
 * Whether the program has a mode in which it blocks changes to files and commands by itself
 * (spec 007, "Permission levels"). `supported` is false when the app cannot show that it does.
 */
export interface ReadOnlySupport {
  readonly kind: RuntimeKind
  readonly supported: boolean
}

/** The usage window of a subscription, as the vendor reports it. */
export interface RuntimeLimit {
  /** For example "five_hour" or "seven_day". */
  readonly window: string
  /** 0 to 1. */
  readonly used: number
  /** When the window resets, in ms since the epoch. */
  readonly resetsAt: number | null
}

/**
 * Which sign-in of a vendor program a call is about. `signIn` is absent or null for the sign-in
 * that the program has on this computer.
 */
export interface RuntimeTarget {
  readonly kind: RuntimeKind
  readonly signIn?: string | null
}

/**
 * The state of an agent runtime on this computer (spec 006, "Readiness of an agent runtime").
 * "checking" is temporary and ends within `RUNTIME_CHECK_MS` in one of the others.
 */
export const RUNTIME_STATES = [
  "checking",
  "ready",
  "needs_sign_in",
  "needs_repair",
  "not_installed",
] as const
export type RuntimeState = (typeof RUNTIME_STATES)[number]

/** The most time a check may take. After it, the row shows a state, never "Checking". */
export const RUNTIME_CHECK_MS = 15_000

/**
 * Why a program needs repair, in four kinds: its file is gone or moved, it does not start, it does
 * not answer, or its answer cannot be read (spec 006).
 */
export const REPAIR_REASONS = ["gone", "start", "answer", "unreadable"] as const
export type RepairReason = (typeof REPAIR_REASONS)[number]

/** The states in which an agent on the program cannot work, and the reason for each. */
export interface RuntimeProblem {
  readonly kind: RuntimeKind
  readonly state: "needs_repair" | "not_installed"
  readonly reason: RepairReason | null
}

/** True for the states that stop an agent: the message box is off (spec 006). */
export const isBlockingState = (state: RuntimeState): state is "needs_repair" | "not_installed" =>
  state === "needs_repair" || state === "not_installed"

/** What the app knows about one vendor program on this computer, for one sign-in of it. */
export interface RuntimeStatus {
  readonly kind: RuntimeKind
  /** Whose sign-in this is: a separate sign-in of an account, or null for the program's own. */
  readonly signIn: string | null
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
  /** The state of the program. A look that is not finished yet shows "checking". */
  readonly state: RuntimeState
  /** Why the program needs repair. Set only in the state "needs_repair". */
  readonly reason: RepairReason | null
  /** When the last check ended, in ms since the epoch. Null before the first check. */
  readonly checkedAt: number | null
  readonly busy: "installing" | "signing_in" | "repairing" | null
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
 * except pi and opencode, whose lists are asked from the program and are empty here.
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
    : kind === "pi" || kind === "opencode"
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
  /**
   * For a new account of a kind that can have one: the separate sign-in to use (see
   * `SIGN_IN_ID`). Without it the account uses the sign-in of the program on this computer. An
   * account that exists keeps the sign-in that it was made with.
   */
  signIn: Schema.optionalKey(Schema.String.check(Schema.isPattern(SIGN_IN_ID))),
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
