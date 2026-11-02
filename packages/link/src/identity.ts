import { sha256 } from "@noble/hashes/sha2.js"
import { b64, fromB64, type RandomBytes, systemRandom, toHex } from "./bytes.ts"
import { generateKeyPair, type KeyPair, publicKeyOf } from "./crypto/noise.ts"

/** The long-term key of a device. The private part lives in the secret store of the system. */
export interface Identity extends KeyPair {
  readonly id: string
}

/** The id of a device: 32 hex digits of the SHA-256 hash of its public key. */
export const deviceIdOf = (publicKey: Uint8Array) => toHex(sha256(publicKey)).slice(0, 32)

/** The identity of a private key. */
export const identityOf = (privateKey: Uint8Array): Identity => {
  const publicKey = publicKeyOf(privateKey)
  return { privateKey, publicKey, id: deviceIdOf(publicKey) }
}

/** The name of the identity in the secret store. */
export const SECRET_NAME = "link-identity"

/** A secret store that answers at once (the keychain of the desktop). */
export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** A secret store that answers later (the secure store of the phone). */
export interface AsyncSecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

const fromStored = (stored: string | null): Identity | undefined => {
  if (!stored) return undefined
  try {
    const raw = fromB64(stored)
    return raw.length === 32 ? identityOf(raw) : undefined
  } catch {
    return undefined
  }
}

/** Reads the identity from the secret store, or makes it on first start. */
export const loadIdentity = (
  secrets: SecretStore,
  random: RandomBytes = systemRandom,
): { identity: Identity; created: boolean } => {
  const found = fromStored(secrets.get(SECRET_NAME))
  if (found) return { identity: found, created: false }
  const fresh = generateKeyPair(random)
  secrets.set(SECRET_NAME, b64(fresh.privateKey))
  return { identity: identityOf(fresh.privateKey), created: true }
}

/** The same as `loadIdentity`, for a store that answers later. */
export const loadIdentityAsync = async (
  secrets: AsyncSecretStore,
  random: RandomBytes = systemRandom,
): Promise<{ identity: Identity; created: boolean }> => {
  const found = fromStored(await secrets.get(SECRET_NAME))
  if (found) return { identity: found, created: false }
  const fresh = generateKeyPair(random)
  await secrets.set(SECRET_NAME, b64(fresh.privateKey))
  return { identity: identityOf(fresh.privateKey), created: true }
}
