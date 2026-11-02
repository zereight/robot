import { describe, expect, test } from "bun:test"
import {
  b64,
  bigintToBytes,
  bytesToBigint,
  concat,
  decodeUtf8,
  encodeUtf8,
  equalBytes,
  fromB64,
  fromBase64,
  fromHex,
  fromUtf8,
  systemRandom,
  toBase64,
  toHex,
  utf8,
} from "./bytes.ts"

const texts = ["", "a", "ROBot", "안녕하세요", "emoji 🤖 and 𝄞", "mixed 한국어 text\nwith lines"]

describe("bytes", () => {
  test("the UTF-8 coder for engines with no text coder gives the same bytes as Node", () => {
    for (const text of texts) {
      const node = new Uint8Array(Buffer.from(text, "utf8"))
      expect(toHex(encodeUtf8(text))).toBe(toHex(node))
      expect(decodeUtf8(node)).toBe(text)
      expect(fromUtf8(utf8(text))).toBe(text)
    }
  })

  test("a broken UTF-8 sequence and a lone surrogate become U+FFFD", () => {
    expect(decodeUtf8(Uint8Array.of(0x61, 0xc3))).toBe("a\ufffd")
    expect(decodeUtf8(Uint8Array.of(0xed, 0xa0, 0x80))).toBe("\ufffd\ufffd\ufffd")
    expect(toHex(encodeUtf8("\ud800"))).toBe("efbfbd")
  })

  test("base64 reads and writes both forms like Node", () => {
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 255)
      const node = Buffer.from(bytes)
      expect(toBase64(bytes)).toBe(node.toString("base64"))
      expect(b64(bytes)).toBe(node.toString("base64url"))
      expect(equalBytes(fromBase64(node.toString("base64")), bytes)).toBe(true)
      expect(equalBytes(fromB64(node.toString("base64url")), bytes)).toBe(true)
    }
    expect(() => fromBase64("a$bc")).toThrow()
    expect(() => fromBase64("abcde")).toThrow()
  })

  test("hex, numbers, concat and compare", () => {
    expect(toHex(fromHex("00ff10"))).toBe("00ff10")
    expect(() => fromHex("0g")).toThrow()
    expect(bytesToBigint(bigintToBytes(123456789n, 8))).toBe(123456789n)
    expect(toHex(concat(Uint8Array.of(1), Uint8Array.of(), Uint8Array.of(2, 3)))).toBe("010203")
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true)
    expect(equalBytes(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false)
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false)
  })

  test("random bytes come from the secure source and differ", () => {
    const a = systemRandom(70_000)
    const b = systemRandom(70_000)
    expect(a.length).toBe(70_000)
    expect(equalBytes(a, b)).toBe(false)
  })
})
