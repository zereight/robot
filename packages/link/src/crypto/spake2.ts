import { p256 } from "@noble/curves/nist.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { hmac } from "@noble/hashes/hmac.js"
import { scrypt, scryptAsync } from "@noble/hashes/scrypt.js"
import { sha256 } from "@noble/hashes/sha2.js"
import {
  bigintToBytes,
  bytesToBigint,
  concat,
  equalBytes,
  fromHex,
  type RandomBytes,
  systemRandom,
  utf8,
} from "../bytes.ts"

/**
 * SPAKE2 as RFC 9382 defines it, with the ciphersuite P-256, SHA-256, HKDF and HMAC.
 *
 * Two devices that share a short secret (the pairing code) use it to make a strong key. A
 * listener on the network gets nothing it can test offline, and a device that guesses must ask
 * the other side once per guess. The second round (key confirmation) shows both sides that they
 * used the same secret.
 */

const Point = p256.Point
const ORDER: bigint = Point.Fn.ORDER

// The fixed points M and N of the RFC for P-256 (Section 6, compressed SEC1 form).
const M_HEX = "02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f"
const N_HEX = "03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49"
// The label of the key confirmation in the RFC (Section 4).
const CONFIRMATION_KEYS = "ConfirmationKeys"
const M = Point.fromBytes(fromHex(M_HEX))
const N = Point.fromBytes(fromHex(N_HEX))

/** The role "A" speaks first and uses M. The role "B" answers and uses N. */
export type Spake2Role = "A" | "B"

export interface Spake2Options {
  /** The identity strings of A and B, as the RFC calls them. */
  readonly idA: string
  readonly idB: string
  /** Extra data that both sides must hold the same. */
  readonly aad?: Uint8Array
  /** Only for test vectors: the private value. A normal run draws a fresh one. */
  readonly ephemeral?: bigint
  /** The source of the private value. The secure source of the system by default. */
  readonly random?: RandomBytes
}

export interface Spake2Result {
  /** The shared key (the RFC's Ke), 16 bytes. */
  readonly key: Uint8Array
  /** The proof this side sends to the other side. */
  readonly confirmation: Uint8Array
  /** True when `confirmation` from the other side proves the same secret. */
  verify(confirmation: Uint8Array): boolean
}

const u64le = (n: number) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true)
  return out
}
const field = (bytes: Uint8Array) => concat(u64le(bytes.length), bytes)

/** A private value, uniform in [1, ORDER - 1], by rejection sampling. */
const randomScalar = (random: RandomBytes) => {
  for (;;) {
    const candidate = bytesToBigint(random(32))
    if (candidate > 0n && candidate < ORDER) return candidate
  }
}

/**
 * How a pairing code becomes the number `w` that both sides share. The RFC asks for a
 * memory-hard function: this is scrypt, and 48 bytes reduced by the group order keep the bias
 * small. A side may run scrypt with another library, with these values.
 */
export const PAIR_SCRYPT = {
  salt: "ROBot device link: pairing code",
  N: 1 << 15,
  r: 8,
  p: 1,
  dkLen: 48,
} as const

/** The number `w` from the 48 bytes of scrypt. */
export const wFromScrypt = (bytes: Uint8Array): bigint => bytesToBigint(bytes) % ORDER

const scryptOptions = {
  N: PAIR_SCRYPT.N,
  r: PAIR_SCRYPT.r,
  p: PAIR_SCRYPT.p,
  dkLen: PAIR_SCRYPT.dkLen,
  maxmem: 64 * 1024 * 1024,
}

/** Turns a pairing code into `w`. It blocks for a moment; a screen uses `codeToWAsync`. */
export const codeToW = (code: string): bigint =>
  wFromScrypt(scrypt(utf8(code), utf8(PAIR_SCRYPT.salt), scryptOptions))

/** The same as `codeToW`, in small steps, so a screen still draws while it runs. */
export const codeToWAsync = async (code: string): Promise<bigint> =>
  wFromScrypt(
    await scryptAsync(utf8(code), utf8(PAIR_SCRYPT.salt), { ...scryptOptions, asyncTick: 10 }),
  )

export class Spake2 {
  readonly #w: bigint
  readonly #x: bigint
  readonly #role: Spake2Role
  readonly #options: Spake2Options
  /** The message for the other side: an uncompressed SEC1 point, 65 bytes. */
  readonly message: Uint8Array

  constructor(role: Spake2Role, w: bigint, options: Spake2Options) {
    this.#role = role
    this.#w = w % ORDER
    if (this.#w === 0n) throw new Error("spake2: w is zero")
    this.#options = options
    this.#x = options.ephemeral ?? randomScalar(options.random ?? systemRandom)
    // pA = w*M + x*P, or pB = w*N + y*P.
    const own = (role === "A" ? M : N).multiply(this.#w).add(Point.BASE.multiply(this.#x))
    this.message = own.toBytes(false)
  }

  /** Takes the message of the other side. Throws when it is not a point of the group. */
  finish(peerMessage: Uint8Array): Spake2Result {
    const peer = Point.fromBytes(peerMessage)
    peer.assertValidity()
    const other = this.#role === "A" ? N : M
    // K = h*x*(peer - w*other). The cofactor h of P-256 is 1.
    const unmasked = peer.subtract(other.multiply(this.#w))
    if (unmasked.is0()) throw new Error("spake2: the shared point is the identity")
    const shared = unmasked.multiply(this.#x)
    if (shared.is0()) throw new Error("spake2: the shared point is the identity")
    const k = shared.toBytes(false)
    const peerCopy = Uint8Array.from(peerMessage)
    const pA = this.#role === "A" ? this.message : peerCopy
    const pB = this.#role === "A" ? peerCopy : this.message
    const tt = concat(
      field(utf8(this.#options.idA)),
      field(utf8(this.#options.idB)),
      field(pA),
      field(pB),
      field(k),
      field(bigintToBytes(this.#w, 32)),
    )
    const digest = sha256(tt)
    const ke = digest.slice(0, 16)
    const ka = digest.slice(16, 32)
    const confirmationKeys = hkdf(
      sha256,
      ka,
      new Uint8Array(0),
      concat(utf8(CONFIRMATION_KEYS), this.#options.aad ?? new Uint8Array(0)),
      32,
    )
    const kcA = confirmationKeys.slice(0, 16)
    const kcB = confirmationKeys.slice(16, 32)
    const mine = this.#role === "A" ? kcA : kcB
    const theirs = this.#role === "A" ? kcB : kcA
    const expected = hmac(sha256, theirs, tt)
    return {
      key: ke,
      confirmation: hmac(sha256, mine, tt),
      verify: (confirmation) => equalBytes(Uint8Array.from(confirmation), expected),
    }
  }
}
