import type { Connection } from "./client.ts"

/**
 * How long Anthropic keeps the start of a request ready for the next one (spec 006). "short" is
 * the default of the provider, 5 minutes. "long" is 1 hour: a write costs more, and the cache
 * pays back as soon as one request comes after a pause of more than 5 minutes.
 */
export type CacheLifetime = "short" | "long"

/** The host of the Anthropic API. It takes the marker of the cache. */
export const OFFICIAL_HOST = "api.anthropic.com"

/**
 * Whether the endpoint of an account takes the marker of the cache. Only an account of the kind
 * Anthropic on the official host does. A proxy or a compatible endpoint can refuse a field that it
 * does not know, and then no chat would work; some of them are documented to refuse this one.
 * Accounts that speak the OpenAI API cache by themselves and never get the marker.
 * `extraHosts` are hosts that a test run adds, for a stand-in provider on this computer.
 */
export const takesCacheMarker = (
  connection: Connection,
  extraHosts: readonly string[] = [],
): boolean => {
  if (connection.kind !== "anthropic") return false
  try {
    const url = new URL(connection.baseUrl)
    if (url.hostname === OFFICIAL_HOST) return url.protocol === "https:"
    return extraHosts.includes(url.hostname)
  } catch {
    return false
  }
}

/** The marker as the request carries it, on the top level of the body. */
export interface CacheMarker {
  readonly type: "ephemeral"
  readonly ttl?: "1h"
}

export const cacheMarker = (lifetime: CacheLifetime): CacheMarker =>
  lifetime === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }
