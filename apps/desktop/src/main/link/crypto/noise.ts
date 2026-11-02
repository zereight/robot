import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from "node:crypto"

/**
 * The Noise protocol framework (revision 34), as its specification defines it, with the suite
 * `25519_AESGCM_SHA256`: X25519 for key agreement, AES-256-GCM to seal, SHA-256 to hash. Only the two patterns that the device link uses are here:
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
  readonly publicKey: Buffer
  readonly privateKey: Buffer
}

// X25519 keys travel as raw 32 bytes. Node wants them wrapped in ASN.1.
// The fixed start of a PKCS#8 / SPKI file for an X25519 key (RFC 8410), so `node:crypto` can load a raw key.
const PRIVATE_PREFIX_HEX = "302e020100300506032b656e04220420"
const PRIVATE_PREFIX = Buffer.from(PRIVATE_PREFIX_HEX, "hex")
const PUBLIC_PREFIX_HEX = "302a300506032b656e032100"
const PUBLIC_PREFIX = Buffer.from(PUBLIC_PREFIX_HEX, "hex")

const privateObject = (raw: Buffer) =>
  createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, raw]), format: "der", type: "pkcs8" })
const publicObject = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, raw]), format: "der", type: "spki" })

export const publicKeyOf = (privateKey: Buffer): Buffer =>
  createPublicKey(privateObject(privateKey))
    .export({ format: "der", type: "spki" })
    .subarray(-DHLEN) as Buffer

export const generateKeyPair = (): KeyPair => {
  const { privateKey } = generateKeyPairSync("x25519")
  const raw = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-DHLEN)
  const secret = Buffer.from(raw)
  return { privateKey: secret, publicKey: publicKeyOf(secret) }
}

const dh = (privateKey: Buffer, publicKey: Buffer): Buffer =>
  diffieHellman({ privateKey: privateObject(privateKey), publicKey: publicObject(publicKey) })

const hash = (data: Buffer) => createHash("sha256").update(data).digest()
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest()

/** HKDF as the Noise specification writes it (Section 4.3), with two or three outputs. */
const hkdf = (chainingKey: Buffer, input: Buffer, outputs: 2 | 3): Buffer[] => {
  const temp = hmac(chainingKey, input)
  const out1 = hmac(temp, Buffer.from([1]))
  const out2 = hmac(temp, Buffer.concat([out1, Buffer.from([2])]))
  if (outputs === 2) return [out1, out2]
  return [out1, out2, hmac(temp, Buffer.concat([out2, Buffer.from([3])]))]
}

/** A key and a counter. The counter is the nonce, so no message is sealed twice with one nonce. */
export class CipherState {
  #key: Buffer | null
  #n = 0n

  constructor(key: Buffer | null = null) {
    this.#key = key
  }

  hasKey() {
    return this.#key !== null
  }

  #nonce() {
    // 32 bits of zero, then the 64-bit counter, big endian (the AESGCM rule of the specification).
    const nonce = Buffer.alloc(12)
    nonce.writeBigUInt64BE(this.#n, 4)
    return nonce
  }

  seal(ad: Buffer, plaintext: Buffer): Buffer {
    if (!this.#key) return plaintext
    if (this.#n === 0xffffffffffffffffn) throw new Error("noise: nonce used up")
    const cipher = createCipheriv("aes-256-gcm", this.#key, this.#nonce(), {
      authTagLength: TAG,
    })
    cipher.setAAD(ad)
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
    this.#n++
    return sealed
  }

  open(ad: Buffer, ciphertext: Buffer): Buffer {
    if (!this.#key) return ciphertext
    if (ciphertext.length < TAG) throw new Error("noise: message too short")
    const decipher = createDecipheriv("aes-256-gcm", this.#key, this.#nonce(), {
      authTagLength: TAG,
    })
    decipher.setAAD(ad)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG))
    const plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - TAG)),
      decipher.final(),
    ])
    this.#n++
    return plaintext
  }
}

class SymmetricState {
  ck: Buffer
  h: Buffer
  cipher = new CipherState()

  constructor(protocolName: string) {
    const name = Buffer.from(protocolName)
    this.h =
      name.length <= HASHLEN
        ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)])
        : hash(name)
    this.ck = this.h
  }

  mixHash(data: Buffer) {
    this.h = hash(Buffer.concat([this.h, data]))
  }

  mixKey(input: Buffer) {
    const [ck, key] = hkdf(this.ck, input, 2) as [Buffer, Buffer]
    this.ck = ck
    this.cipher = new CipherState(key)
  }

  encryptAndHash(plaintext: Buffer) {
    const ciphertext = this.cipher.seal(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Buffer) {
    const plaintext = this.cipher.open(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, Buffer.alloc(0), 2) as [Buffer, Buffer]
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
  readonly prologue: Buffer
  readonly staticKey: KeyPair
  /** The static public key of the other side, when the pattern says it is known. */
  readonly remoteStatic?: Buffer
  /** Only for test vectors: a fixed ephemeral key. A normal run draws a fresh one. */
  readonly ephemeral?: KeyPair
}

export interface NoiseDone {
  /** Seals what this side sends. */
  readonly send: CipherState
  /** Opens what the other side sends. */
  readonly receive: CipherState
  readonly handshakeHash: Buffer
  readonly remoteStatic: Buffer
}

/** One handshake. Call `write` and `read` in the order of the pattern, one message each. */
export class NoiseHandshake {
  readonly #options: NoiseOptions
  readonly #pattern: Pattern
  readonly #state: SymmetricState
  #step = 0
  #remoteStatic: Buffer | undefined
  #remoteEphemeral: Buffer | undefined
  #ephemeral: KeyPair | undefined
  #result: NoiseDone | undefined

  constructor(options: NoiseOptions) {
    this.#options = options
    this.#pattern = PATTERNS[options.pattern]
    this.#remoteStatic = options.remoteStatic
    this.#state = new SymmetricState(`Noise_${options.pattern}_25519_AESGCM_SHA256`)
    this.#state.mixHash(options.prologue)
    for (const [direction, token] of this.#pattern.pre) {
      void token
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
      remoteStatic: this.#remoteStatic ?? Buffer.alloc(0),
    }
  }

  write(payload: Buffer): Buffer {
    const [direction, tokens] = this.#expectedDirection()
    if ((direction === "->") !== this.#options.initiator) throw new Error("noise: not our turn")
    const out: Buffer[] = []
    for (const token of tokens) {
      if (token === "e") {
        this.#ephemeral = this.#options.ephemeral ?? generateKeyPair()
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
    return Buffer.concat(out)
  }

  read(message: Buffer): Buffer {
    const [direction, tokens] = this.#expectedDirection()
    if ((direction === "->") === this.#options.initiator) throw new Error("noise: not our turn")
    let offset = 0
    const take = (length: number) => {
      if (offset + length > message.length) throw new Error("noise: message too short")
      const part = message.subarray(offset, offset + length)
      offset += length
      return part
    }
    for (const token of tokens) {
      if (token === "e") {
        this.#remoteEphemeral = Buffer.from(take(DHLEN))
        this.#state.mixHash(this.#remoteEphemeral)
      } else if (token === "s") {
        const length = DHLEN + (this.#state.cipher.hasKey() ? TAG : 0)
        this.#remoteStatic = Buffer.from(this.#state.decryptAndHash(Buffer.from(take(length))))
      } else {
        this.#diffieHellman(token)
      }
    }
    const payload = this.#state.decryptAndHash(Buffer.from(message.subarray(offset)))
    this.#step++
    this.#finish()
    return payload
  }
}
