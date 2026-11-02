/** Shapes of keys and tokens. Logs and exports replace a match with a mark. */
const PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export const REDACTED = "[redacted]"

/** Hides anything in `text` that looks like a secret, and every value in `known`. */
export const redactSecrets = (text: string, known: readonly string[] = []): string => {
  let out = text
  for (const secret of known) {
    // Short values would hide ordinary words.
    if (secret.length >= 8) out = out.split(secret).join(REDACTED)
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

/**
 * True when `text` looks like a secret (spec 014): it holds a stored value from `known`, or a key
 * or token of a known form.
 */
export const looksLikeSecret = (text: string, known: readonly string[] = []): boolean =>
  redactSecrets(text, known) !== text
