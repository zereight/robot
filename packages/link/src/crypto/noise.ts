import { gcm } from "@noble/ciphers/aes.js"
import { x25519 } from "@noble/curves/ed25519.js"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concat, type RandomBytes, systemRandom } from "../bytes.ts"

/**
 * The Noise protocol framework (revision 34), as its specification defines it, with the suite
 * `25519_AESGCM_SHA256`: X25519 for key agreement, AES-256-GCM to seal, SHA-256 to hash. Only the
 * two patterns that the device link uses are here:
 *
 * - `IK`: the client knows the server's key; the server learns the client's key from the first
 *   message. The server can answer, signed by its own key, also when it does not know the client.
 * - `KK`: both sides know the key of the other. Only the tests use it, because the Noise test
 *   vectors cover it.
 *
 * Messages of one handshake are small. Transport messages are at most 65535 bytes, as the
 * specification asks.
 */

const DHLEN = 32
const HASHLEN = 32
const TAG = 16
export const NOISE_MAX_MESSAGE = 65535

export interface KeyPair {
  readonly publicKey: Uint8Array
  readonly privateKey: Uint8Array
}

export const publicKeyOf = (privateKey: Uint8Array): Uint8Array => x25519.getPublicKey(privateKey)

/** A new key pair from the secure random source. X25519 takes any 32 bytes as a private key. */
export const generateKeyPair = (random: RandomBytes = systemRandom): KeyPair => {
  const privateKey = random(DHLEN)
  return { privateKey, publicKey: publicKeyOf(privateKey) }
}

const dh = (privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array =>
  x25519.getSharedSecret(privateKey, publicKey)

const hash = (data: Uint8Array) => sha256(data)
const mac = (key: Uint8Array, data: Uint8Array) => hmac(sha256, key, data)

/** HKDF as the Noise specification writes it (Section 4.3), with two or three outputs. */
const hkdf = (chainingKey: Uint8Array, input: Uint8Array, outputs: 2 | 3): Uint8Array[] => {
  const temp = mac(chainingKey, input)
  const out1 = mac(temp, Uint8Array.of(1))
  const out2 = mac(temp, concat(out1, Uint8Array.of(2)))
  if (outputs === 2) return [out1, out2]
  return [out1, out2, mac(temp, concat(out2, Uint8Array.of(3)))]
}

const EMPTY = new Uint8Array(0)

/** A key and a counter. The counter is the nonce, so no message is sealed twice with one nonce. */
export class CipherState {
  #key: Uint8Array | null
  #n = 0n

  constructor(key: Uint8Array | null = null) {
    this.#key = key
  }

  hasKey() {
    return this.#key !== null
  }

  #nonce() {
    // 32 bits of zero, then the 64-bit counter, big endian (the AESGCM rule of the specification).
    const nonce = new Uint8Array(12)
    new DataView(nonce.buffer).setBigUint64(4, this.#n, false)
    return nonce
  }

  seal(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.#key) return plaintext
    if (this.#n === 0xffffffffffffffffn) throw new Error("noise: nonce used up")
    const sealed = gcm(this.#key, this.#nonce(), ad.length ? ad : EMPTY).encrypt(plaintext)
    this.#n++
    return sealed
  }

  open(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.#key) return ciphertext
    if (ciphertext.length < TAG) throw new Error("noise: message too short")
    // A wrong tag throws, and the counter does not move, so a later true message still opens.
    const plaintext = gcm(this.#key, this.#nonce(), ad.length ? ad : EMPTY).decrypt(ciphertext)
    this.#n++
    return plaintext
  }
}

class SymmetricState {
  ck: Uint8Array
  h: Uint8Array
  cipher = new CipherState()

  constructor(protocolName: string) {
    const name = Uint8Array.from(protocolName, (c) => c.charCodeAt(0))
    this.h =
      name.length <= HASHLEN ? concat(name, new Uint8Array(HASHLEN - name.length)) : hash(name)
    this.ck = this.h
  }

  mixHash(data: Uint8Array) {
    this.h = hash(concat(this.h, data))
  }

  mixKey(input: Uint8Array) {
    const [ck, key] = hkdf(this.ck, input, 2) as [Uint8Array, Uint8Array]
    this.ck = ck
    this.cipher = new CipherState(key)
  }

  encryptAndHash(plaintext: Uint8Array) {
    const ciphertext = this.cipher.seal(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array) {
    const plaintext = this.cipher.open(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY, 2) as [Uint8Array, Uint8Array]
    return [new CipherState(k1), new CipherState(k2)]
  }
}

type Token = "e" | "s" | "ee" | "es" | "se" | "ss"
type Pattern = {
  /** Keys known before the first message: who knows whose static key. */
  readonly pre: readonly (readonly ["->" | "<-", "s"])[]
  readonly messages: readonly (readonly ["->" | "<-", readonly Token[]])[]
}

const PATTERNS = {
  IK: {
    pre: [["<-", "s"]],
    messages: [
      ["->", ["e", "es", "s", "ss"]],
      ["<-", ["e", "ee", "se"]],
    ],
  },
  KK: {
    pre: [
      ["->", "s"],
      ["<-", "s"],
    ],
    messages: [
      ["->", ["e", "es", "ss"]],
      ["<-", ["e", "ee", "se"]],
    ],
  },
} as const satisfies Record<string, Pattern>

export type NoiseName = keyof typeof PATTERNS

export interface NoiseOptions {
  readonly pattern: NoiseName
  readonly initiator: boolean
  readonly prologue: Uint8Array
  readonly staticKey: KeyPair
  /** The static public key of the other side, when the pattern says it is known. */
  readonly remoteStatic?: Uint8Array
  /** Only for test vectors: a fixed ephemeral key. A normal run draws a fresh one. */
  readonly ephemeral?: KeyPair
  /** The source of the ephemeral key. The secure source of the system by default. */
  readonly random?: RandomBytes
}

export interface NoiseDone {
  /** Seals what this side sends. */
  readonly send: CipherState
  /** Opens what the other side sends. */
  readonly receive: CipherState
  readonly handshakeHash: Uint8Array
  readonly remoteStatic: Uint8Array
}

/** One handshake. Call `write` and `read` in the order of the pattern, one message each. */
export class NoiseHandshake {
  readonly #options: NoiseOptions
  readonly #pattern: Pattern
  readonly #state: SymmetricState
  #step = 0
  #remoteStatic: Uint8Array | undefined
  #remoteEphemeral: Uint8Array | undefined
  #ephemeral: KeyPair | undefined
  #result: NoiseDone | undefined

  constructor(options: NoiseOptions) {
    this.#options = options
    this.#pattern = PATTERNS[options.pattern]
    this.#remoteStatic = options.remoteStatic
    this.#state = new SymmetricState(`Noise_${options.pattern}_25519_AESGCM_SHA256`)
    this.#state.mixHash(options.prologue)
    for (const [direction] of this.#pattern.pre) {
      const mine = (direction === "->") === options.initiator
      const key = mine ? options.staticKey.publicKey : this.#remoteStatic
      if (!key) throw new Error("noise: the key of the other side is needed")
      this.#state.mixHash(key)
    }
  }

  /** The static key of the other side, once the handshake has shown it. */
  get remoteStatic() {
    return this.#remoteStatic
  }

  get done() {
    return this.#result
  }

  #expectedDirection() {
    const step = this.#pattern.messages[this.#step]
    if (!step) throw new Error("noise: the handshake is complete")
    return step
  }

  #diffieHellman(token: "ee" | "es" | "se" | "ss") {
    const initiator = this.#options.initiator
    const s = this.#options.staticKey.privateKey
    const e = this.#ephemeral?.privateKey
    const rs = this.#remoteStatic
    const re = this.#remoteEphemeral
    // "es" is the initiator's ephemeral with the responder's static; "se" is the reverse.
    const [local, remote] =
      token === "ee"
        ? [e, re]
        : token === "ss"
          ? [s, rs]
          : token === "es"
            ? initiator
              ? [e, rs]
              : [s, re]
            : initiator
              ? [s, re]
              : [e, rs]
    if (!local || !remote) throw new Error("noise: a key is missing")
    this.#state.mixKey(dh(local, remote))
  }

  #finish() {
    if (this.#step < this.#pattern.messages.length) return
    const [first, second] = this.#state.split()
    this.#result = {
      send: this.#options.initiator ? first : second,
      receive: this.#options.initiator ? second : first,
      handshakeHash: this.#state.h,
      remoteStatic: this.#remoteStatic ?? EMPTY,
    }
  }

  write(payload: Uint8Array): Uint8Array {
    const [direction, tokens] = this.#expectedDirection()
    if ((direction === "->") !== this.#options.initiator) throw new Error("noise: not our turn")
    const out: Uint8Array[] = []
    for (const token of tokens) {
      if (token === "e") {
        this.#ephemeral = this.#options.ephemeral ?? generateKeyPair(this.#options.random)
        out.push(this.#ephemeral.publicKey)
        this.#state.mixHash(this.#ephemeral.publicKey)
      } else if (token === "s") {
        out.push(this.#state.encryptAndHash(this.#options.staticKey.publicKey))
      } else {
        this.#diffieHellman(token)
      }
    }
    out.push(this.#state.encryptAndHash(payload))
    this.#step++
    this.#finish()
    return concat(...out)
  }

  read(message: Uint8Array): Uint8Array {
    const [direction, tokens] = this.#expectedDirection()
    if ((direction === "->") === this.#options.initiator) throw new Error("noise: not our turn")
    let offset = 0
    const take = (length: number) => {
      if (offset + length > message.length) throw new Error("noise: message too short")
      const part = message.slice(offset, offset + length)
      offset += length
      return part
    }
    for (const token of tokens) {
      if (token === "e") {
        this.#remoteEphemeral = take(DHLEN)
        this.#state.mixHash(this.#remoteEphemeral)
      } else if (token === "s") {
        const length = DHLEN + (this.#state.cipher.hasKey() ? TAG : 0)
        this.#remoteStatic = this.#state.decryptAndHash(take(length))
      } else {
        this.#diffieHellman(token)
      }
    }
    const payload = this.#state.decryptAndHash(message.slice(offset))
    this.#step++
    this.#finish()
    return payload
  }
}
