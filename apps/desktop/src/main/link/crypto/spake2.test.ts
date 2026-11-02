import { describe, expect, test } from "bun:test"
import { codeToW, Spake2 } from "./spake2.ts"

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex")

// The first and the last test vector of RFC 9382, Appendix B (P256-SHA256-HKDF-HMAC).
const vectors = [
  {
    idA: "server",
    idB: "client",
    w: 0x2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5fn,
    x: 0x43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729n,
    pA: "04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c",
    y: 0xdcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66ben,
    pB: "0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7",
    ke: "0e0672dc86f8e45565d338b0540abe69",
    confA: "58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0",
    confB: "d3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b",
  },
  {
    idA: "",
    idB: "",
    w: 0x7bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70ccan,
    x: 0x8cef65df64bb2d0f83540c53632de911b5b24b3eab6cc74a97609fd659e95473n,
    pA: "04a65b367a3f613cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f46ca1ef6a676598889fc28de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66",
    y: 0xd7a66f64074a84652d8d623a92e20c9675c61cb5b4f6a0063e4648a2fdc02d53n,
    pB: "04589f13218822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494662eea8ba6b64692dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d",
    ke: "fc6374762ba5cf11f4b2caa08b2cd1b9",
    confA: "dfb4db8d48ae5a675963ea5e6c19d98d4ea028d8e898dad96ea19a80ade95dca",
    confB: "d0f0609d1613138d354f7e95f19fb556bf52d751947241e8c7118df5ef0ae175",
  },
]

describe("SPAKE2 (RFC 9382)", () => {
  for (const [i, v] of vectors.entries()) {
    test(`test vector ${i + 1} of the RFC`, () => {
      const options = { idA: v.idA, idB: v.idB }
      const a = new Spake2("A", v.w, { ...options, ephemeral: v.x })
      const b = new Spake2("B", v.w, { ...options, ephemeral: v.y })
      expect(hex(a.message)).toBe(v.pA)
      expect(hex(b.message)).toBe(v.pB)
      const ra = a.finish(b.message)
      const rb = b.finish(a.message)
      expect(hex(ra.key)).toBe(v.ke)
      expect(hex(rb.key)).toBe(v.ke)
      expect(hex(ra.confirmation)).toBe(v.confA)
      expect(hex(rb.confirmation)).toBe(v.confB)
      expect(rb.verify(ra.confirmation)).toBe(true)
      expect(ra.verify(rb.confirmation)).toBe(true)
    })
  }

  test("the same code gives the same key and different codes do not", () => {
    const options = { idA: "client", idB: "server" }
    const run = (codeA: string, codeB: string) => {
      const a = new Spake2("A", codeToW(codeA), options)
      const b = new Spake2("B", codeToW(codeB), options)
      const ra = a.finish(b.message)
      const rb = b.finish(a.message)
      return { ra, rb }
    }
    const same = run("123456", "123456")
    expect(same.ra.key.equals(same.rb.key)).toBe(true)
    expect(same.rb.verify(same.ra.confirmation)).toBe(true)
    const wrong = run("123456", "123457")
    expect(wrong.ra.key.equals(wrong.rb.key)).toBe(false)
    expect(wrong.rb.verify(wrong.ra.confirmation)).toBe(false)
    expect(wrong.ra.verify(wrong.rb.confirmation)).toBe(false)
  })

  test("a message that is not a point of the group is refused", () => {
    const a = new Spake2("A", codeToW("123456"), { idA: "client", idB: "server" })
    expect(() => a.finish(Buffer.alloc(65, 4))).toThrow()
    expect(() => a.finish(Buffer.alloc(3))).toThrow()
  })

  test("the data that both sides add must match", () => {
    const w = codeToW("000000")
    const a = new Spake2("A", w, { idA: "c", idB: "s", aad: Buffer.from("v1") })
    const b = new Spake2("B", w, { idA: "c", idB: "s", aad: Buffer.from("v2") })
    const ra = a.finish(b.message)
    const rb = b.finish(a.message)
    expect(rb.verify(ra.confirmation)).toBe(false)
  })
})
