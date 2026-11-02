import {
  deviceIdOf as deviceIdOfBytes,
  loadIdentity as loadWith,
  type SecretStore,
} from "@robot/link"

export type { SecretStore } from "@robot/link"
export { SECRET_NAME } from "@robot/link"

/**
 * The long-term key of this device, as Node buffers, so the desktop can compare and store it. The
 * private part lives in the keychain and nowhere else.
 */
export interface Identity {
  readonly id: string
  readonly publicKey: Buffer
  readonly privateKey: Buffer
}

/** The id of a device: 32 hex digits of the SHA-256 hash of its public key. */
export const deviceIdOf = (publicKey: Uint8Array) => deviceIdOfBytes(publicKey)

export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
export const fromB64 = (text: string) => Buffer.from(text, "base64url")

/** Reads the identity from the secret store, or makes it on first start. */
export const loadIdentity = (secrets: SecretStore): { identity: Identity; created: boolean } => {
  const { identity, created } = loadWith(secrets)
  return {
    identity: {
      id: identity.id,
      publicKey: Buffer.from(identity.publicKey),
      privateKey: Buffer.from(identity.privateKey),
    },
    created,
  }
}
