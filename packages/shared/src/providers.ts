import { Schema } from "effect"

export const ProviderKind = Schema.Literals(["openai", "anthropic", "custom"])
export type ProviderKind = typeof ProviderKind.Type

export const defaultBaseUrls: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  custom: "",
}

/** One model account. Its key is in the system keychain, never here. */
export interface ProviderAccount {
  readonly id: string
  readonly kind: ProviderKind
  readonly name: string
  readonly baseUrl: string
  /** True when the app holds a key for this account. */
  readonly connected: boolean
}

export interface ModelInfo {
  readonly id: string
  readonly label: string
  /** Effort levels the model takes. Empty when it has none. */
  readonly efforts: readonly string[]
}

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

export const ProviderConnect = Schema.Struct({
  /** Give it to connect an existing account again. */
  accountId: Schema.optionalKey(Schema.String),
  kind: ProviderKind,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
  baseUrl: HttpUrl,
  apiKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
})
export type ProviderConnect = typeof ProviderConnect.Type

export const EFFORTS = ["low", "medium", "high"] as const

/** Effort levels for a model id, from what each vendor documents for its model families. */
export const effortsFor = (kind: ProviderKind, modelId: string): readonly string[] => {
  const id = modelId.toLowerCase()
  if (kind === "openai" && /^(o\d|gpt-5)/.test(id)) return EFFORTS
  if (
    kind === "anthropic" &&
    /^claude-(3-7|[a-z]+-[4-9]|[4-9]|opus-[4-9]|sonnet-[4-9]|haiku-[4-9])/.test(id)
  ) {
    return EFFORTS
  }
  return []
}
