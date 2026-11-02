import { createHash } from "node:crypto"
import { generateKeyPair, type KeyPair, publicKeyOf } from "./crypto/noise.ts"

/** The long-term key of this device. The private part lives in the keychain and nowhere else. */
export interface Identity extends KeyPair {
  readonly id: string
}

/** The id of a device: 32 hex digits of the SHA-256 hash of its public key. */
export const deviceIdOf = (publicKey: Buffer) =>
  createHash("sha256").update(publicKey).digest("hex").slice(0, 32)

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
export const fromB64 = (text: string) => Buffer.from(text, "base64url")

export const SECRET_NAME = "link-identity"

export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

const make = (privateKey: Buffer): Identity => {
  const publicKey = publicKeyOf(privateKey)
  return { privateKey, publicKey, id: deviceIdOf(publicKey) }
}

/** Reads the identity from the secret store, or makes it on first start. */
export const loadIdentity = (secrets: SecretStore): { identity: Identity; created: boolean } => {
  const stored = secrets.get(SECRET_NAME)
  if (stored) {
    const raw = fromB64(stored)
    if (raw.length === 32) return { identity: make(raw), created: false }
  }
  const fresh = generateKeyPair()
  secrets.set(SECRET_NAME, b64(fresh.privateKey))
  return { identity: make(fresh.privateKey), created: true }
}
