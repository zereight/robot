import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { createServer } from "node:net"
import { type Address, LINK_PROTOCOL, type WireDevice } from "@robot/shared"
import type WebSocket from "ws"
import { Conn, pairingCiphers, SecureChannel } from "./channel.ts"
import { failureCode, LinkError, openAny, openLinked, pairWithCode } from "./client.ts"
import { generateKeyPair } from "./crypto/noise.ts"
import { codeToW } from "./crypto/spake2.ts"
import { deviceIdOf, type Identity } from "./identity.ts"
import type { JoinResult } from "./protocol.ts"
import { type ClientSession, type LinkHost, LinkServer, type ServerOffer } from "./server.ts"

const identityOf = (): Identity => {
  const pair = generateKeyPair()
  return { ...pair, id: deviceIdOf(pair.publicKey) }
}

interface Rig {
  host: LinkHost & {
    accepting: () => boolean
    state: {
      accept: boolean
      offer: (ServerOffer & { code: string; ended: boolean; tries: number }) | undefined
      clients: Map<string, WireDevice>
      sessions: ClientSession[]
      decision: JoinResult
      joins: unknown[]
    }
  }
  server: LinkServer
  port: number
}

const servers: LinkServer[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

const rig = async (handshakeMs?: number): Promise<Rig> => {
  const identity = identityOf()
  const state: Rig["host"]["state"] = {
    accept: true,
    offer: undefined,
    clients: new Map(),
    sessions: [],
    decision: { ok: true, addresses: [] },
    joins: [],
  }
  const host: Rig["host"] = {
    identity,
    device: () => ({ id: identity.id, name: "Server", kind: "computer" }),
    serverId: () => "server-1",
    appVersion: () => "0.0.0",
    accepting: () => state.accept,
    offer: () => state.offer,
    wrongCode: (offer) => {
      const o = offer as NonNullable<typeof state.offer>
      o.tries++
      if (o.tries >= 5) (o as { ended: boolean }).ended = true
    },
    useCode: (offer) => {
      const o = offer as NonNullable<typeof state.offer>
      if (o.ended) return false
      ;(o as { ended: boolean }).ended = true
      return true
    },
    join: async (request) => {
      state.joins.push(request)
      return state.decision
    },
    client: (publicKey) => state.clients.get(publicKey.toString("hex")),
    session: (session) => {
      state.sessions.push(session)
    },
    state,
  }
  const server = new LinkServer(host, handshakeMs ? { handshakeMs } : {})
  servers.push(server)
  const port = await server.listen(0)
  return { host, server, port }
}

const offerFor = (code: string) => ({ w: codeToW(code), code, ended: false, tries: 0 })
const addr = (port: number) => `127.0.0.1:${port}`

describe("pairing run", () => {
  test("the right code opens an encrypted channel and shows the identity of the server", async () => {
    const { host, port } = await rig()
    host.state.offer = offerFor("123456")
    const { conn } = await openAny([addr(port)])
    const { channel, hello } = await pairWithCode(conn, "123456")
    expect(hello.device.name).toBe("Server")
    expect(hello.device.kind).toBe("computer")
    expect(hello.device.serverId).toBe("server-1")
    // The code is used up.
    expect(host.state.offer?.ended).toBe(true)

    const client = identityOf()
    const joined = new Promise<Record<string, unknown>>((resolve) =>
      channel.onMessage((m) => resolve(m as Record<string, unknown>)),
    )
    channel.send({
      type: "join",
      v: LINK_PROTOCOL,
      device: {
        id: client.id,
        name: "Phone",
        kind: "phone",
        publicKey: client.publicKey.toString("base64url"),
        serverId: "client-1",
      },
      twoWay: false,
      addresses: [],
    })
    const answer = await joined
    expect(answer).toMatchObject({ type: "joined", ok: true })
    expect(host.state.joins).toHaveLength(1)
  })

  test("a wrong code is refused, and the fifth wrong code ends the code", async () => {
    const { host, port } = await rig()
    host.state.offer = offerFor("123456")
    for (let i = 0; i < 5; i++) {
      const { conn } = await openAny([addr(port)])
      await expect(pairWithCode(conn, "654321")).rejects.toMatchObject({ code: "wrong_code" })
    }
    expect(host.state.offer?.ended).toBe(true)
    // Even the right code does not work now.
    const { conn } = await openAny([addr(port)])
    await expect(pairWithCode(conn, "123456")).rejects.toMatchObject({ code: "code_ended" })
  })

  test("with no code on screen the server says the code ended", async () => {
    const { port } = await rig()
    const { conn } = await openAny([addr(port)])
    await expect(pairWithCode(conn, "123456")).rejects.toMatchObject({ code: "code_ended" })
  })

  test("a code works once", async () => {
    const { host, port } = await rig()
    host.state.offer = offerFor("111111")
    const first = await openAny([addr(port)])
    await pairWithCode(first.conn, "111111")
    const second = await openAny([addr(port)])
    await expect(pairWithCode(second.conn, "111111")).rejects.toMatchObject({ code: "code_ended" })
  })

  test("a server that does not accept says so", async () => {
    const { host, port } = await rig()
    host.state.accept = false
    host.state.offer = offerFor("123456")
    const { conn } = await openAny([addr(port)])
    await expect(pairWithCode(conn, "123456")).rejects.toMatchObject({ code: "not_accepting" })
  })

  test("a closed port is reported as a computer that does not accept connections", async () => {
    const { server, port } = await rig()
    server.close()
    await expect(openAny([addr(port)], 1000)).rejects.toMatchObject({ code: "not_accepting" })
  })

  test("a client with another protocol version gets a clear error", async () => {
    const { port } = await rig()
    const { conn } = await openAny([addr(port)])
    conn.sendText({ robot: "link", v: LINK_PROTOCOL + 1, mode: "pair", a: "AA" })
    const reply = await conn.nextText(2000)
    expect(reply).toMatchObject({ t: "error", code: "version", v: LINK_PROTOCOL })
  })

  test("the code never travels as text", async () => {
    const { host, port } = await rig()
    host.state.offer = offerFor("424242")
    const { conn } = await openAny([addr(port)])
    const seen: string[] = []
    const rawSend = conn.ws.send.bind(conn.ws)
    conn.ws.send = ((data: unknown, ...rest: unknown[]) => {
      seen.push(String(data))
      return (rawSend as (...a: unknown[]) => void)(data, ...rest)
    }) as typeof conn.ws.send
    await pairWithCode(conn, "424242")
    expect(seen.join("")).not.toContain("424242")
  })
})

describe("code of a failed connection", () => {
  // A web socket that follows the browser API (the one built into Bun 1.4.2) reports a failure
  // as an event with no system code. The app asks the system, so this must give the same answer
  // on every runtime.
  const event = { type: "error", message: "Failed to connect" }
  const closed = async (): Promise<Address> => {
    const { server, port } = await rig()
    server.close()
    return { host: "127.0.0.1", port }
  }

  test("a system code of the error is kept as it is, with no second connection", async () => {
    // A second connection to this closed port would say ECONNREFUSED.
    const address = await closed()
    for (const code of [
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
    ]) {
      const error = Object.assign(new Error(code), { code })
      expect(await failureCode(error, address, 1000)).toBe(code)
    }
  })

  test("an error with no code, such as a handshake that timed out, is not a refusal", async () => {
    const address = await closed()
    const error = new Error("Opening handshake has timed out")
    expect(await failureCode(error, address, 1000)).toBe("ERR")
  })

  test("an event with no code from a closed port is a refusal", async () => {
    expect(await failureCode(event, await closed(), 1000)).toBe("ECONNREFUSED")
  })

  test("an event with no code from a port that accepts is not a refusal", async () => {
    const listener = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    try {
      const address = { host: "127.0.0.1", port: (listener.address() as { port: number }).port }
      expect(await failureCode(event, address, 1000)).toBe("ERR")
    } finally {
      listener.close()
    }
  })

  test("an event with no code from an unknown host is not a refusal", async () => {
    const code = await failureCode(event, { host: "no-such-host.invalid", port: 81 }, 1500)
    expect(code).not.toBe("ECONNREFUSED")
  }, 10_000)

  test("an event with no code from an address that never answers is not a refusal", async () => {
    // 192.0.2.1 is a documentation address: no route, or no answer until the time ends.
    const code = await failureCode(event, { host: "192.0.2.1", port: 81 }, 200)
    expect(code).not.toBe("ECONNREFUSED")
  }, 10_000)

  test("an unknown host reads as a computer that is not reachable", async () => {
    await expect(openAny(["no-such-host.invalid:81"], 1500)).rejects.toMatchObject({
      code: "unreachable",
    })
  }, 10_000)
})

describe("linked connection", () => {
  const device = (identity: Identity): WireDevice => ({
    id: identity.id,
    name: "Laptop",
    kind: "computer",
  })

  test("a linked client opens a channel and both sides can talk", async () => {
    const { host, port } = await rig()
    const client = identityOf()
    host.state.clients.set(client.publicKey.toString("hex"), device(client))
    const { conn } = await openAny([addr(port)])
    const linked = await openLinked(
      conn,
      client,
      { publicKey: host.identity.publicKey },
      device(client),
    )
    expect(linked.device.name).toBe("Server")
    expect(linked.serverId).toBe("server-1")
    const session = await new Promise<ClientSession>((resolve) => {
      const check = () => {
        const s = host.state.sessions[0]
        if (s) resolve(s)
        else setTimeout(check, 10)
      }
      check()
    })
    expect(session.device.id).toBe(client.id)
    const got = new Promise((resolve) => session.channel.onMessage(resolve))
    linked.channel.send({ v: 1, type: "request", id: 1, method: "places.list" })
    expect(await got).toMatchObject({ method: "places.list" })
    const back = new Promise((resolve) => linked.channel.onMessage(resolve))
    session.channel.send({ v: 1, type: "event", id: 1, event: "places.changed" })
    expect(await back).toMatchObject({ event: "places.changed" })
  })

  test("a long message crosses in several records", async () => {
    const { host, port } = await rig()
    const client = identityOf()
    host.state.clients.set(client.publicKey.toString("hex"), device(client))
    const { conn } = await openAny([addr(port)])
    const linked = await openLinked(
      conn,
      client,
      { publicKey: host.identity.publicKey },
      device(client),
    )
    const session = await new Promise<ClientSession>((resolve) => {
      const check = () =>
        host.state.sessions[0] ? resolve(host.state.sessions[0]) : setTimeout(check, 10)
      check()
    })
    const big = "x".repeat(300_000)
    const got = new Promise<{ input: string }>((resolve) =>
      session.channel.onMessage((m) => resolve(m as { input: string })),
    )
    linked.channel.send({ v: 1, type: "request", id: 2, method: "m", input: big })
    expect((await got).input).toBe(big)
  })

  test("a device that is not linked is told so, signed by the server, and is closed", async () => {
    const { host, port } = await rig()
    const stranger = identityOf()
    const { conn } = await openAny([addr(port)])
    const closed = new Promise<number>((resolve) => conn.onClose(resolve))
    await expect(
      openLinked(conn, stranger, { publicKey: host.identity.publicKey }, device(stranger)),
    ).rejects.toMatchObject({ code: "not_allowed" })
    expect(await closed).toBeGreaterThan(0)
    expect(host.state.sessions).toHaveLength(0)
  })

  test("a client that holds the wrong key for the server gets no answer", async () => {
    const { host, port } = await rig()
    const client = identityOf()
    host.state.clients.set(client.publicKey.toString("hex"), device(client))
    const { conn } = await openAny([addr(port)])
    const impostor = generateKeyPair()
    await expect(
      openLinked(conn, client, { publicKey: impostor.publicKey }, device(client)),
    ).rejects.toBeInstanceOf(Error)
    expect(host.state.sessions).toHaveLength(0)
  })

  test("with the switch off a linked device cannot connect", async () => {
    const { host, port, server } = await rig()
    const client = identityOf()
    host.state.clients.set(client.publicKey.toString("hex"), device(client))
    host.state.accept = false
    const { conn } = await openAny([addr(port)])
    await expect(
      openLinked(conn, client, { publicKey: host.identity.publicKey }, device(client)),
    ).rejects.toBeInstanceOf(LinkError)
    expect(host.state.sessions).toHaveLength(0)
    server.close()
  })

  test("a raw connection that sends nothing is closed", async () => {
    const { port } = await rig(300)
    const { conn } = await openAny([addr(port)])
    const closed = new Promise<boolean>((resolve) => conn.onClose(() => resolve(true)))
    expect(await closed).toBe(true)
  })
})

describe("a message that comes with the last handshake message", () => {
  // A fake socket that keeps what is sent, so a test can deliver frames in any order.
  const fakeSocket = () => {
    const ws = new EventEmitter() as EventEmitter & {
      sent: Buffer[]
      send: unknown
      close: unknown
    }
    ws.sent = []
    ws.send = (data: Buffer) => ws.sent.push(data)
    ws.close = () => {}
    return ws
  }

  test("is kept until the handler is set, and then arrives in order", () => {
    const key = Buffer.alloc(16, 7)
    const serverSocket = fakeSocket()
    const server = new SecureChannel(
      new Conn(serverSocket as unknown as WebSocket),
      pairingCiphers(key, false),
    )
    server.send({ type: "hello", n: 1 })
    server.send({ type: "next", n: 2 })

    // Both frames reach the client before it has made its channel.
    const clientSocket = fakeSocket()
    const conn = new Conn(clientSocket as unknown as WebSocket)
    for (const frame of serverSocket.sent) clientSocket.emit("message", frame, true)
    const channel = new SecureChannel(conn, pairingCiphers(key, true))
    const seen: unknown[] = []
    channel.onMessage((m) => seen.push(m))
    expect(seen).toEqual([
      { type: "hello", n: 1 },
      { type: "next", n: 2 },
    ])

    // Later messages go straight to the handler.
    server.send({ type: "late", n: 3 })
    clientSocket.emit("message", serverSocket.sent[2], true)
    expect(seen).toHaveLength(3)
  })
})
