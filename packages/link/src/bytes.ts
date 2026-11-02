/**
 * Small byte helpers that work the same in Bun, Node, Electron and React Native. Hermes, the
 * engine of React Native, has no `Buffer`, and its text coder is not on every version, so the
 * code here does not use them.
 */

export type Bytes = Uint8Array

export const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  let length = 0
  for (const p of parts) length += p.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** True when both hold the same bytes. The time does not depend on where they differ. */
export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

type Coder = { encode?: (text: string) => Uint8Array; decode?: (bytes: Uint8Array) => string }
const g = globalThis as { TextEncoder?: new () => Coder; TextDecoder?: new () => Coder }
const nativeEncoder = g.TextEncoder ? new g.TextEncoder() : undefined
const nativeDecoder = g.TextDecoder ? new g.TextDecoder() : undefined

/** UTF-8 bytes of a text. A lone surrogate becomes U+FFFD, as in `TextEncoder`. */
export const utf8 = (text: string): Uint8Array =>
  nativeEncoder?.encode ? nativeEncoder.encode(text) : encodeUtf8(text)

/** The text of UTF-8 bytes. A broken sequence becomes U+FFFD. */
export const fromUtf8 = (bytes: Uint8Array): string =>
  nativeDecoder?.decode ? nativeDecoder.decode(bytes) : decodeUtf8(bytes)

/** The encoder for an engine that has no `TextEncoder`. Exported for the tests. */
export const encodeUtf8 = (text: string): Uint8Array => {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      } else code = 0xfffd
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      )
  }
  return Uint8Array.from(out)
}

/** The decoder for an engine that has no `TextDecoder`. Exported for the tests. */
export const decodeUtf8 = (bytes: Uint8Array): string => {
  const parts: string[] = []
  let chunk: number[] = []
  const flush = () => {
    parts.push(String.fromCharCode(...chunk))
    chunk = []
  }
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i] as number
    let code = 0xfffd
    let size = 1
    const cont = (k: number) => {
      const c = bytes[i + k]
      return c !== undefined && (c & 0xc0) === 0x80 ? c & 63 : -1
    }
    if (b < 0x80) code = b
    else if (b >= 0xc2 && b < 0xe0) {
      const c1 = cont(1)
      if (c1 >= 0) {
        code = ((b & 31) << 6) | c1
        size = 2
      }
    } else if (b >= 0xe0 && b < 0xf0) {
      const c1 = cont(1)
      const c2 = cont(2)
      const value = ((b & 15) << 12) | (c1 << 6) | c2
      if (c1 >= 0 && c2 >= 0 && value >= 0x800 && (value < 0xd800 || value > 0xdfff)) {
        code = value
        size = 3
      }
    } else if (b >= 0xf0 && b < 0xf5) {
      const c1 = cont(1)
      const c2 = cont(2)
      const c3 = cont(3)
      const value = ((b & 7) << 18) | (c1 << 12) | (c2 << 6) | c3
      if (c1 >= 0 && c2 >= 0 && c3 >= 0 && value >= 0x10000 && value <= 0x10ffff) {
        code = value
        size = 4
      }
    }
    i += size
    if (code >= 0x10000) {
      const v = code - 0x10000
      chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff))
    } else chunk.push(code)
    if (chunk.length > 8000) flush()
  }
  flush()
  return parts.join("")
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i
  // The URL form of the alphabet reads the same.
  table["-".charCodeAt(0)] = 62
  table["_".charCodeAt(0)] = 63
  return table
})()

/** Base64 text of bytes. `url` uses `-` and `_` and no padding (RFC 4648, section 5). */
export const toBase64 = (bytes: Uint8Array, url = false): string => {
  const parts: string[] = []
  let line = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    line += ALPHABET[(n >> 18) & 63]
    line += ALPHABET[(n >> 12) & 63]
    line += b === undefined ? (url ? "" : "=") : ALPHABET[(n >> 6) & 63]
    line += c === undefined ? (url ? "" : "=") : ALPHABET[n & 63]
    if (line.length >= 16384) {
      parts.push(line)
      line = ""
    }
  }
  parts.push(line)
  const text = parts.join("")
  return url ? text.replace(/\+/g, "-").replace(/\//g, "_") : text
}

/** Bytes of a base64 text, plain or URL form, with or without padding. Throws on other text. */
export const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/=+$/, "")
  if (clean.length % 4 === 1) throw new Error("base64: wrong length")
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let bits = 0
  let value = 0
  let o = 0
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i)
    const digit = code < 128 ? (LOOKUP[code] as number) : -1
    if (digit < 0) throw new Error("base64: not a base64 character")
    value = (value << 6) | digit
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (value >> bits) & 0xff
    }
  }
  return out
}

/** Base64 URL text with no padding, as the link uses for keys and handshake messages. */
export const b64 = (bytes: Uint8Array) => toBase64(bytes, true)
export const fromB64 = (text: string) => fromBase64(text)

export const toHex = (bytes: Uint8Array) => {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

export const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) throw new Error("hex: not hex")
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const bytesToBigint = (bytes: Uint8Array) =>
  bytes.length === 0 ? 0n : BigInt(`0x${toHex(bytes)}`)

export const bigintToBytes = (n: bigint, length: number) =>
  fromHex(n.toString(16).padStart(length * 2, "0"))

/** A source of random bytes. It must be the secure source of the system. */
export type RandomBytes = (length: number) => Uint8Array

/**
 * The secure random source of the platform (`crypto.getRandomValues`). React Native gets it from
 * the app, which passes the function of `expo-crypto`, so this is only the default.
 */
export const systemRandom: RandomBytes = (length) => {
  const source = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto
  if (!source?.getRandomValues) throw new Error("random: no secure random source")
  const out = new Uint8Array(length)
  // getRandomValues takes at most 65536 bytes at a time.
  for (let i = 0; i < length; i += 65536) source.getRandomValues(out.subarray(i, i + 65536))
  return out
}
