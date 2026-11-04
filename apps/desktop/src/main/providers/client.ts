import type { LimitReason, ModelInfo, ProviderKind, RuntimeKind } from "@robot/shared"
import {
  EFFORT_LEVELS,
  EFFORTS,
  effortsFor,
  limitReasonOf,
  nearestEffort,
  takesThinkingBudget,
} from "@robot/shared"

export interface Connection {
  /** Agent runtimes have no connection: they have no key and no address. */
  readonly kind: Exclude<ProviderKind, RuntimeKind>
  readonly baseUrl: string
  readonly apiKey: string
}

/** Why a request to a provider failed, in terms the user can act on. */
export class ProviderFailure extends Error {
  constructor(
    readonly code:
      | "provider_auth"
      | "provider_unreachable"
      | "provider_error"
      | "provider_limit"
      /** The model is overloaded and asks to try later. */
      | "provider_busy"
      /** The subscription sign-in of an agent runtime is gone or refused. */
      | "runtime_signed_out"
      /**
       * The program of an agent runtime could not start. `detail` is the reason (`RepairReason`):
       * the app sets the state of the program to "Needs repair" at once (spec 006).
       */
      | "runtime_start",
    readonly detail?: string,
    /** When a usage limit resets, if the provider says. */
    readonly resetsAt?: number,
    /** Which limit it is, for the code "provider_limit": the plan, the credit or the quota (spec 006). */
    readonly reason?: LimitReason,
  ) {
    super(detail ?? code)
  }
}

/**
 * A failure with the code "provider_limit" and its limit reason (spec 006, "Backup model"). The
 * reason comes from the words of the report. A report that names none counts as the plan limit:
 * the code was always the usage limit of the account.
 */
export const limitFailure = (text: string, resetsAt?: number): ProviderFailure =>
  new ProviderFailure("provider_limit", text, resetsAt, limitReasonOf(text) ?? "plan")

const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`

export const headersFor = (c: Connection): Record<string, string> =>
  c.kind === "anthropic"
    ? { "x-api-key": c.apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${c.apiKey}` }

export const urlFor = (c: Connection, path: "models" | "chat") => {
  if (c.kind === "anthropic")
    return join(c.baseUrl, path === "models" ? "/v1/models" : "/v1/messages")
  return join(c.baseUrl, path === "models" ? "/models" : "/chat/completions")
}

/** Reads the reset time from common rate limit headers. */
const resetTime = (response: Response): number | undefined => {
  const retryAfter = response.headers.get("retry-after")
  if (retryAfter && /^\d+$/.test(retryAfter)) return Date.now() + Number(retryAfter) * 1000
  const anthropicReset = response.headers.get("anthropic-ratelimit-requests-reset")
  if (anthropicReset && !Number.isNaN(Date.parse(anthropicReset))) return Date.parse(anthropicReset)
  return undefined
}

const errorMessage = async (response: Response) => {
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string
      message?: string
    }
    if (typeof body.error === "string") return body.error
    return body.error?.message ?? body.message ?? response.statusText
  } catch {
    return response.statusText
  }
}

/** Turns a failed HTTP response into a `ProviderFailure`. */
export const failureFrom = async (response: Response): Promise<ProviderFailure> => {
  const message = await errorMessage(response)
  if (response.status === 401 || response.status === 403)
    return new ProviderFailure("provider_auth", message)
  if (response.status === 429) return limitFailure(message, resetTime(response))
  // A spent credit or quota can come with another status (spec 006, "Backup model").
  if (
    (response.status === 400 || response.status === 402) &&
    (["credit", "quota"].includes(limitReasonOf(message) ?? "") || /usage limits?/i.test(message))
  )
    return limitFailure(message, resetTime(response))
  // 503 is the status of an overloaded OpenAI model; 529 is the status that Anthropic uses.
  if (response.status === 503 || response.status === 529 || /overloaded/i.test(message))
    return new ProviderFailure("provider_busy", message)
  return new ProviderFailure("provider_error", `${response.status} ${message}`)
}

export const request = async (url: string, init: RequestInit, signal?: AbortSignal) => {
  try {
    return await fetch(url, { ...init, signal: signal ?? AbortSignal.timeout(20_000) })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ProviderFailure(
      "provider_unreachable",
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * The effort levels that a model of a list says it takes, from the lowest to the highest. A level
 * counts when the entry names it with `supported: true`; any level that the app knows may be
 * named, also None, Minimal and Ultra (spec 006). Null when the entry does not say, as with a
 * proxy that leaves the capabilities out; the caller then goes by the model name.
 */
export const effortsFromCapabilities = (capabilities: unknown): readonly string[] | null => {
  const effort = (capabilities as { effort?: unknown } | null | undefined)?.effort
  if (effort === null || typeof effort !== "object") return null
  const levels = effort as Record<string, unknown>
  if (levels.supported !== true) return []
  return EFFORT_LEVELS.filter(
    (level) => (levels[level] as { supported?: unknown } | null | undefined)?.supported === true,
  )
}

/**
 * The effort levels that a model takes. The model list of the account counts when it names the
 * model. Without that, what the vendor documents for the model id decides. An agent runtime has
 * no such document, so for a model that its list does not name there is no level.
 */
export const offeredEfforts = (
  kind: ProviderKind,
  model: string,
  listed?: readonly ModelInfo[],
): readonly string[] => listed?.find((m) => m.id === model)?.efforts ?? effortsFor(kind, model)

/**
 * The levels of an Anthropic model. The model list tells them when it can. A model that takes no
 * effort setting but thinks with a token budget has the three levels that set the budget. When the
 * list says nothing, the model name decides.
 */
export const anthropicEfforts = (id: string, capabilities: unknown): readonly string[] => {
  const told = effortsFromCapabilities(capabilities)
  if (told === null) return effortsFor("anthropic", id)
  if (told.length > 0) return told
  return takesThinkingBudget(id) ? EFFORTS : []
}

/**
 * The levels of a model of any API list. The entry says them when it can (all levels count, spec
 * 006). Otherwise the name decides, and an Anthropic model that thinks with a token budget has the
 * three levels that set the budget.
 */
export const modelEfforts = (
  kind: ProviderKind,
  id: string,
  capabilities: unknown,
): readonly string[] => {
  if (kind === "anthropic") return anthropicEfforts(id, capabilities)
  const told = effortsFromCapabilities(capabilities)
  return told !== null && told.length > 0 ? told : effortsFor(kind, id)
}

/**
 * The level that a turn sends (spec 006, "Effort levels"). The model that runs the turn counts.
 * When it does not list the level, the nearest level that it lists is sent, and the lower one when
 * two are equally near; a model with no levels gets none. `listed` is the model list of the account
 * when the app has it. For a model that the list does not name, the name decides an Anthropic
 * model, and the level of another provider goes as it is.
 */
export const effortToSend = (
  kind: ProviderKind,
  model: string,
  effort: string | null,
  listed?: readonly ModelInfo[],
): string | null => {
  if (effort === null) return null
  const known = listed?.find((m) => m.id === model)
  if (known) return nearestEffort(effort, known.efforts)
  if (kind !== "anthropic") return effort
  return nearestEffort(effort, effortsFor(kind, model))
}

/**
 * Lists the models of an account, in the order of the provider. It is also the connection check:
 * one small request. The picker puts the newest first (spec 006).
 */
export const listModels = async (c: Connection): Promise<ModelInfo[]> => {
  const response = await request(urlFor(c, "models"), { headers: headersFor(c) })
  if (!response.ok) throw await failureFrom(response)
  const body = (await response.json()) as {
    data?: ({
      id: string
      display_name?: string
      capabilities?: unknown
    } & ContextFields &
      DateFields)[]
  }
  return (body.data ?? []).map((m) => {
    const contextWindow = contextWindowOf(m)
    const created = createdOf(m)
    return {
      id: m.id,
      label: m.display_name ?? m.id,
      efforts: modelEfforts(c.kind, m.id, m.capabilities),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(created !== undefined ? { created } : {}),
    }
  })
}

/** The fields in which a model list can tell when a model was made. */
interface DateFields {
  created_at?: unknown
  created?: unknown
}

/**
 * When the provider made the model, in ms since the epoch: `created_at` is a date text (Anthropic),
 * `created` a number of seconds (OpenAI) or of milliseconds. Undefined when the entry does not
 * tell it, or tells something that is not a time.
 */
export const createdOf = (m: DateFields): number | undefined => {
  if (typeof m.created_at === "string") {
    const time = Date.parse(m.created_at)
    if (Number.isFinite(time) && time > 0) return time
  }
  if (typeof m.created === "number" && Number.isFinite(m.created) && m.created > 0)
    return m.created < 1e11 ? Math.round(m.created * 1000) : Math.round(m.created)
  return undefined
}

/** The fields in which a model list can tell the size of the context of a model. */
interface ContextFields {
  context_length?: unknown
  context_window?: unknown
  max_input_tokens?: unknown
}

/**
 * The size of the context of a model, from its entry in the model list (spec 003, "Context meter").
 * Providers name it in different ways. Undefined when the entry does not tell it.
 */
export const contextWindowOf = (m: ContextFields): number | undefined => {
  for (const value of [m.max_input_tokens, m.context_window, m.context_length]) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}
