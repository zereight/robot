import type { ModelInfo, ProviderKind, RuntimeKind } from "@robot/shared"
import { CLAUDE_EFFORTS, effortsFor } from "@robot/shared"

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
      | "runtime_signed_out",
    readonly detail?: string,
    /** When a usage limit resets, if the provider says. */
    readonly resetsAt?: number,
  ) {
    super(detail ?? code)
  }
}

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
  if (response.status === 429)
    return new ProviderFailure("provider_limit", message, resetTime(response))
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
 * The effort levels that a model of the Anthropic list says it takes. Null when the entry does not
 * say, as with a proxy that leaves the capabilities out; the caller then goes by the model name.
 */
export const effortsFromCapabilities = (capabilities: unknown): readonly string[] | null => {
  const effort = (capabilities as { effort?: unknown } | null | undefined)?.effort
  if (effort === null || typeof effort !== "object") return null
  const levels = effort as Record<string, unknown>
  if (levels.supported !== true) return []
  return CLAUDE_EFFORTS.filter(
    (level) => (levels[level] as { supported?: unknown } | null | undefined)?.supported === true,
  )
}

/**
 * The effort of an agent, kept only if an Anthropic model still takes it. The agent keeps the level
 * it was given; a model that takes no such level would refuse the request. `listed` is the model
 * list of the account when the app has it. Without it, the model name decides.
 */
export const keepEffort = (
  kind: ProviderKind,
  model: string,
  effort: string | null,
  listed?: readonly ModelInfo[],
): string | null => {
  if (effort === null || kind !== "anthropic") return effort
  const offered = listed?.find((m) => m.id === model)?.efforts ?? effortsFor(kind, model)
  return offered.includes(effort) ? effort : null
}

/** Lists the models of an account. It is also the connection check: one small request. */
export const listModels = async (c: Connection): Promise<ModelInfo[]> => {
  const response = await request(urlFor(c, "models"), { headers: headersFor(c) })
  if (!response.ok) throw await failureFrom(response)
  const body = (await response.json()) as {
    data?: { id: string; display_name?: string; capabilities?: unknown }[]
  }
  return (body.data ?? [])
    .map((m) => ({
      id: m.id,
      label: m.display_name ?? m.id,
      efforts:
        (c.kind === "anthropic" ? effortsFromCapabilities(m.capabilities) : null) ??
        effortsFor(c.kind, m.id),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
