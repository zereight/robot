import { describe, expect, test } from "bun:test"
import { generateKeyPair, type KeyPair, NoiseHandshake, publicKeyOf } from "./noise.ts"
import { noiseVectors } from "./noise.vectors.ts"

const keyPair = (privateHex: string): KeyPair => {
  const privateKey = Buffer.from(privateHex, "hex")
  return { privateKey, publicKey: publicKeyOf(privateKey) }
}

describe("Noise handshake", () => {
  for (const v of noiseVectors) {
    test(`reproduces the test vector ${v.name}`, () => {
      const prologue = Buffer.from(v.prologue, "hex")
      const initStatic = keyPair(v.initStatic)
      const respStatic = keyPair(v.respStatic)
      // The public keys that the vector gives for the other side match the private keys.
      if (v.initRemoteStatic) {
        expect(respStatic.publicKey.toString("hex")).toBe(v.initRemoteStatic)
      }
      if (v.respRemoteStatic) {
        expect(initStatic.publicKey.toString("hex")).toBe(v.respRemoteStatic)
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

      const m1 = initiator.write(Buffer.from(first.payload, "hex"))
      expect(m1.toString("hex")).toBe(first.ciphertext)
      expect(responder.read(m1).toString("hex")).toBe(first.payload)
      const m2 = responder.write(Buffer.from(second.payload, "hex"))
      expect(m2.toString("hex")).toBe(second.ciphertext)
      expect(initiator.read(m2).toString("hex")).toBe(second.payload)

      const a = initiator.done
      const b = responder.done
      if (!a || !b) throw new Error("handshake did not finish")
      expect(a.handshakeHash.toString("hex")).toBe(v.handshakeHash)
      expect(b.handshakeHash.toString("hex")).toBe(v.handshakeHash)
      expect(b.remoteStatic.equals(initStatic.publicKey)).toBe(true)
      expect(a.remoteStatic.equals(respStatic.publicKey)).toBe(true)

      for (const [i, message] of transport.entries()) {
        const fromInitiator = i % 2 === 0
        const sender = fromInitiator ? a.send : b.send
        const receiver = fromInitiator ? b.receive : a.receive
        const sealed = sender.seal(Buffer.alloc(0), Buffer.from(message.payload, "hex"))
        expect(sealed.toString("hex")).toBe(message.ciphertext)
        expect(receiver.open(Buffer.alloc(0), sealed).toString("hex")).toBe(message.payload)
      }
    })
  }

  test("IK: the server learns the key of the client from the first message", () => {
    const client = generateKeyPair()
    const server = generateKeyPair()
    const prologue = Buffer.from("test")
    const c = new NoiseHandshake({
      pattern: "IK",
      initiator: true,
      prologue,
      staticKey: client,
      remoteStatic: server.publicKey,
    })
    const s = new NoiseHandshake({ pattern: "IK", initiator: false, prologue, staticKey: server })
    s.read(c.write(Buffer.from("hello")))
    expect(s.remoteStatic?.equals(client.publicKey)).toBe(true)
    c.read(s.write(Buffer.from("welcome")))
    expect(c.done?.handshakeHash.equals(s.done?.handshakeHash ?? Buffer.alloc(0))).toBe(true)
  })

  test("IK: a client that has the wrong key for the server fails at the first message", () => {
    const client = generateKeyPair()
    const server = generateKeyPair()
    const other = generateKeyPair()
    const prologue = Buffer.from("test")
    const c = new NoiseHandshake({
      pattern: "IK",
      initiator: true,
      prologue,
      staticKey: client,
      remoteStatic: other.publicKey,
    })
    const s = new NoiseHandshake({ pattern: "IK", initiator: false, prologue, staticKey: server })
    expect(() => s.read(c.write(Buffer.from("hello")))).toThrow()
  })

  test("a different prologue fails", () => {
    const client = generateKeyPair()
    const server = generateKeyPair()
    const c = new NoiseHandshake({
      pattern: "IK",
      initiator: true,
      prologue: Buffer.from("v1"),
      staticKey: client,
      remoteStatic: server.publicKey,
    })
    const s = new NoiseHandshake({
      pattern: "IK",
      initiator: false,
      prologue: Buffer.from("v2"),
      staticKey: server,
    })
    expect(() => s.read(c.write(Buffer.alloc(0)))).toThrow()
  })

  test("a changed or repeated transport message is refused", () => {
    const client = generateKeyPair()
    const server = generateKeyPair()
    const prologue = Buffer.from("test")
    const c = new NoiseHandshake({
      pattern: "IK",
      initiator: true,
      prologue,
      staticKey: client,
      remoteStatic: server.publicKey,
    })
    const s = new NoiseHandshake({ pattern: "IK", initiator: false, prologue, staticKey: server })
    s.read(c.write(Buffer.alloc(0)))
    c.read(s.write(Buffer.alloc(0)))
    const sealed = c.done?.send.seal(Buffer.alloc(0), Buffer.from("data")) as Buffer
    const receive = s.done?.receive
    const flipped = Buffer.from(sealed)
    flipped[0] = (flipped[0] ?? 0) ^ 1
    expect(() => receive?.open(Buffer.alloc(0), flipped)).toThrow()
    expect(receive?.open(Buffer.alloc(0), sealed).toString()).toBe("data")
    expect(() => receive?.open(Buffer.alloc(0), sealed)).toThrow()
  })
})
