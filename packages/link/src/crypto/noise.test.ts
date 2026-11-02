import { describe, expect, test } from "bun:test"
import { equalBytes, fromHex, fromUtf8, toHex, utf8 } from "../bytes.ts"
import { generateKeyPair, type KeyPair, NoiseHandshake, publicKeyOf } from "./noise.ts"
import { noiseVectors } from "./noise.vectors.ts"

const keyPair = (privateHex: string): KeyPair => {
  const privateKey = fromHex(privateHex)
  return { privateKey, publicKey: publicKeyOf(privateKey) }
}

describe("Noise handshake", () => {
  for (const v of noiseVectors) {
    test(`reproduces the test vector ${v.name}`, () => {
      const prologue = fromHex(v.prologue)
      const initStatic = keyPair(v.initStatic)
      const respStatic = keyPair(v.respStatic)
      // The public keys that the vector gives for the other side match the private keys.
      if (v.initRemoteStatic) {
        expect(toHex(respStatic.publicKey)).toBe(v.initRemoteStatic)
      }
      if (v.respRemoteStatic) {
        expect(toHex(initStatic.publicKey)).toBe(v.respRemoteStatic)
      }
      const initiator = new NoiseHandshake({
        pattern: v.pattern,
        initiator: true,
        prologue,
        staticKey: initStatic,
        remoteStatic: respStatic.publicKey,
        ephemeral: keyPair(v.initEphemeral),
      })
      const responder = new NoiseHandshake({
        pattern: v.pattern,
        initiator: false,
        prologue,
        staticKey: respStatic,
        ...(v.pattern === "KK" ? { remoteStatic: initStatic.publicKey } : {}),
        ephemeral: keyPair(v.respEphemeral),
      })
      const [first, second, ...transport] = v.messages
      if (!first || !second) throw new Error("vector has no handshake messages")

      const m1 = initiator.write(fromHex(first.payload))
      expect(toHex(m1)).toBe(first.ciphertext)
      expect(toHex(responder.read(m1))).toBe(first.payload)
      const m2 = responder.write(fromHex(second.payload))
      expect(toHex(m2)).toBe(second.ciphertext)
      expect(toHex(initiator.read(m2))).toBe(second.payload)

      const a = initiator.done
      const b = responder.done
      if (!a || !b) throw new Error("handshake did not finish")
      expect(toHex(a.handshakeHash)).toBe(v.handshakeHash)
      expect(toHex(b.handshakeHash)).toBe(v.handshakeHash)
      expect(equalBytes(b.remoteStatic, initStatic.publicKey)).toBe(true)
      expect(equalBytes(a.remoteStatic, respStatic.publicKey)).toBe(true)

      for (const [i, message] of transport.entries()) {
        const fromInitiator = i % 2 === 0
        const sender = fromInitiator ? a.send : b.send
        const receiver = fromInitiator ? b.receive : a.receive
        const sealed = sender.seal(new Uint8Array(0), fromHex(message.payload))
        expect(toHex(sealed)).toBe(message.ciphertext)
        expect(toHex(receiver.open(new Uint8Array(0), sealed))).toBe(message.payload)
      }
    })
  }

  test("IK: the server learns the key of the client from the first message", () => {
    const client = generateKeyPair()
    const server = generateKeyPair()
    const prologue = utf8("test")
    const c = new NoiseHandshake({
      pattern: "IK",
      initiator: true,
      prologue,
      staticKey: client,
      remoteStatic: server.publicKey,
    })
    const s = new NoiseHandshake({ pattern: "IK", initiator: false, prologue, staticKey: server })
    s.read(c.write(utf8("hello")))
    expect(equalBytes(s.remoteStatic ?? new Uint8Array(0), client.publicKey)).toBe(true)
    c.read(s.write(utf8("welcome")))
    expect(equalBytes(c.done?.handshakeHash ?? utf8("a"), s.done?.handshakeHash ?? utf8("b"))).toBe(
      true,
    )
  })

  test("IK: a client that has the wrong key for the server fails at the first message", () => {
    const client = generateKeyPair()
    const server = generateKeyPair()
    const other = generateKeyPair()
    const prologue = utf8("test")
    const c = new NoiseHandshake({
      pattern: "IK",
      initiator: true,
      prologue,
      staticKey: client,
      remoteStatic: other.publicKey,
    })
    const s = new NoiseHandshake({ pattern: "IK", initiator: false, prologue, staticKey: server })
    expect(() => s.read(c.write(utf8("hello")))).toThrow()
  })

  test("a different prologue fails", () => {
    const client = generateKeyPair()
    const server = generateKeyPair()
    const c = new NoiseHandshake({
      pattern: "IK",
      initiator: true,
      prologue: utf8("v1"),
      staticKey: client,
      remoteStatic: server.publicKey,
    })
    const s = new NoiseHandshake({
      pattern: "IK",
      initiator: false,
      prologue: utf8("v2"),
      staticKey: server,
    })
    expect(() => s.read(c.write(new Uint8Array(0)))).toThrow()
  })

  test("a changed or repeated transport message is refused", () => {
    const client = generateKeyPair()
    const server = generateKeyPair()
    const prologue = utf8("test")
    const c = new NoiseHandshake({
      pattern: "IK",
      initiator: true,
      prologue,
      staticKey: client,
      remoteStatic: server.publicKey,
    })
    const s = new NoiseHandshake({ pattern: "IK", initiator: false, prologue, staticKey: server })
    s.read(c.write(new Uint8Array(0)))
    c.read(s.write(new Uint8Array(0)))
    const sealed = c.done?.send.seal(new Uint8Array(0), utf8("data")) as Uint8Array
    const receive = s.done?.receive
    const flipped = Uint8Array.from(sealed)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(() => receive?.open(new Uint8Array(0), flipped)).toThrow()
    expect(fromUtf8(receive?.open(new Uint8Array(0), sealed) ?? utf8(""))).toBe("data")
    expect(() => receive?.open(new Uint8Array(0), sealed)).toThrow()
  })
})
