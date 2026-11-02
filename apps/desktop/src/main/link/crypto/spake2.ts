import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"
import { p256 } from "@noble/curves/nist.js"

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
const M = Point.fromBytes(Buffer.from(M_HEX, "hex"))
const N = Point.fromBytes(Buffer.from(N_HEX, "hex"))

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
}

export interface Spake2Result {
  /** The shared key (the RFC's Ke), 16 bytes. */
  readonly key: Buffer
  /** The proof this side sends to the other side. */
  readonly confirmation: Buffer
  /** True when `confirmation` from the other side proves the same secret. */
  verify(confirmation: Uint8Array): boolean
}

const u64le = (n: number) => {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(BigInt(n))
  return out
}
const field = (bytes: Uint8Array) => Buffer.concat([u64le(bytes.length), bytes])

const bytesToBigint = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString("hex")}`)
const bigintToBytes = (n: bigint, length: number) =>
  Buffer.from(n.toString(16).padStart(length * 2, "0"), "hex")

/** A private value, uniform in [1, ORDER - 1], by rejection sampling. */
const randomScalar = () => {
  for (;;) {
    const candidate = bytesToBigint(randomBytes(32))
    if (candidate > 0n && candidate < ORDER) return candidate
  }
}

const SALT_TEXT = "ROBot device link: pairing code"
const SALT = Buffer.from(SALT_TEXT)

/**
 * Turns a pairing code into the number `w` that both sides share. The RFC asks for a memory-hard
 * function: this is scrypt, and 48 bytes reduced by the group order keep the bias small.
 */
export const codeToW = (code: string): bigint =>
  bytesToBigint(scryptSync(code, SALT, 48, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })) %
  ORDER

export class Spake2 {
  readonly #w: bigint
  readonly #x: bigint
  readonly #role: Spake2Role
  readonly #options: Spake2Options
  /** The message for the other side: an uncompressed SEC1 point, 65 bytes. */
  readonly message: Buffer

  constructor(role: Spake2Role, w: bigint, options: Spake2Options) {
    this.#role = role
    this.#w = w % ORDER
    if (this.#w === 0n) throw new Error("spake2: w is zero")
    this.#options = options
    this.#x = options.ephemeral ?? randomScalar()
    // pA = w*M + x*P, or pB = w*N + y*P.
    const own = (role === "A" ? M : N).multiply(this.#w).add(Point.BASE.multiply(this.#x))
    this.message = Buffer.from(own.toBytes(false))
  }

  /** Takes the message of the other side. Throws when it is not a point of the group. */
  finish(peerMessage: Uint8Array): Spake2Result {
    const peer = Point.fromBytes(peerMessage)
    peer.assertValidity()
    const other = this.#role === "A" ? N : M
    // K = h*x*(peer - w*other). The cofactor h of P-256 is 1.
    const unmasked = peer.subtract(other.multiply(this.#w))
    const shared = unmasked.multiply(this.#x)
    if (shared.is0()) throw new Error("spake2: the shared point is the identity")
    const k = Buffer.from(shared.toBytes(false))
    const pA = this.#role === "A" ? this.message : Buffer.from(peerMessage)
    const pB = this.#role === "A" ? Buffer.from(peerMessage) : this.message
    const tt = Buffer.concat([
      field(Buffer.from(this.#options.idA)),
      field(Buffer.from(this.#options.idB)),
      field(pA),
      field(pB),
      field(k),
      field(bigintToBytes(this.#w, 32)),
    ])
    const digest = createHash("sha256").update(tt).digest()
    const ke = digest.subarray(0, 16)
    const ka = digest.subarray(16, 32)
    const confirmationKeys = Buffer.from(
      hkdfSync(
        "sha256",
        ka,
        Buffer.alloc(0),
        Buffer.concat([Buffer.from(CONFIRMATION_KEYS), this.#options.aad ?? Buffer.alloc(0)]),
        32,
      ),
    )
    const kcA = confirmationKeys.subarray(0, 16)
    const kcB = confirmationKeys.subarray(16, 32)
    const mine = this.#role === "A" ? kcA : kcB
    const theirs = this.#role === "A" ? kcB : kcA
    const mac = (key: Buffer) => createHmac("sha256", key).update(tt).digest()
    const expected = mac(theirs)
    return {
      key: Buffer.from(ke),
      confirmation: mac(mine),
      verify: (confirmation) =>
        confirmation.length === expected.length &&
        timingSafeEqual(Buffer.from(confirmation), expected),
    }
  }
}
