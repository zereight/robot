import type { ModelInfo, ProviderKind } from "@robot/shared"
import { effortsFor } from "@robot/shared"

export interface Connection {
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly apiKey: string
}

/** Why a request to a provider failed, in terms the user can act on. */
export class ProviderFailure extends Error {
  constructor(
    readonly code: "provider_auth" | "provider_unreachable" | "provider_error" | "provider_limit",
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

/** Lists the models of an account. It is also the connection check: one small request. */
export const listModels = async (c: Connection): Promise<ModelInfo[]> => {
  const response = await request(urlFor(c, "models"), { headers: headersFor(c) })
  if (!response.ok) throw await failureFrom(response)
  const body = (await response.json()) as { data?: { id: string; display_name?: string }[] }
  return (body.data ?? [])
    .map((m) => ({ id: m.id, label: m.display_name ?? m.id, efforts: effortsFor(c.kind, m.id) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
