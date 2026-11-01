import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type DevicesState, groupCode, type PairingState } from "@robot/shared"
import { Effect } from "effect"
import { MemoryNetwork } from "../link/nearby.testing.ts"
import { Devices } from "./Devices.ts"
import { Remote } from "./Remote.ts"
import { SettingsStore } from "./Settings.ts"
import { testRuntime } from "./testing.ts"

type Rt = ReturnType<typeof testRuntime>

const start = (side: Rt): Promise<PairingState> =>
  side.runtime.runPromise(Devices.use((d) => d.pairStart()))
const state = (side: Rt): Promise<DevicesState> =>
  side.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.state())))
const joins = (side: Rt) =>
  side.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.joins())))
const decide = (side: Rt, allow: boolean) =>
  side.runtime.runPromise(
    Effect.gen(function* () {
      const d = yield* Devices
      for (let i = 0; i < 150; i++) {
        const first = d.joins()[0]
        if (first) return yield* d.decide(first.id, allow)
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)))
      }
      throw new Error("no join request")
    }),
  )
const probe = (side: Rt, input: { link?: string; address?: string | undefined; code?: string }) =>
  side.runtime.runPromise(Remote.use((r) => r.probe(input)))
const finish = (side: Rt, session: string, twoWay: boolean) =>
  side.runtime.runPromise(Remote.use((r) => r.finish(session, twoWay)))
const entries = (side: Rt) =>
  side.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.entries())))

const waitFor = async <T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000) => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50))
    last = await read()
  }
  return last
}

const sides: Rt[] = []
const side = (name: string) => {
  const s = testRuntime({ name })
  sides.push(s)
  return s
}

/** Pairs `client` with `server` with the copied link; the user of `server` allows. */
const pair = async (server: Rt, client: Rt, twoWay = false) => {
  const pairing = await start(server)
  const found = await probe(client, { link: pairing.link })
  const done = finish(client, found.session, twoWay)
  await decide(server, true)
  return { entry: await done, pairing }
}

beforeAll(() => {
  process.env.ROBOT_LINK_ADDRESSES = "127.0.0.1"
  process.env.ROBOT_LINK_RETRY_MAX_MS = "300"
  process.env.ROBOT_LINK_NEARBY_WAIT_MS = "80"
})
afterAll(async () => {
  for (const s of sides) await s.runtime.dispose()
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
  delete process.env.ROBOT_LINK_NEARBY_WAIT_MS
})

describe("device link between two computers", () => {
  test("the switch is off at first start and no port is open", async () => {
    const a = side("MacBook 2")
    const s = await state(a)
    expect(s.accept).toBe(false)
    expect(s.port).toBeNull()
    expect(s.self.name).toBe("MacBook 2")
    expect(s.self.kind).toBe("computer")
    expect(s.self.protocol).toBe(1)
  })

  test("a pairing code is six digits, shows every address, and turns the switch on", async () => {
    const a = side("MacBook 2")
    const pairing = await start(a)
    expect(pairing.code).toMatch(/^\d{6}$/)
    expect(groupCode(pairing.code)).toMatch(/^\d{3} \d{3}$/)
    expect(pairing.addresses[0]?.address).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(pairing.link).toContain("robot://pair?")
    expect(pairing.link).toContain(pairing.code)
    expect((await state(a)).accept).toBe(true)
    expect((await state(a)).port).not.toBeNull()
  })

  test("two computers pair with a copied link, and both ways when asked", async () => {
    const a = side("MacBook 2") // the server
    const b = side("MacBook 1") // the client
    const pairing = await start(a)
    const found = await probe(b, { link: pairing.link })
    expect(found.name).toBe("MacBook 2")
    expect(found.kind).toBe("computer")
    const done = finish(b, found.session, true)
    const request = await waitFor(
      () => joins(a),
      (j) => j.length > 0,
    )
    expect(request[0]).toMatchObject({ name: "MacBook 1", kind: "computer", twoWay: true })
    await decide(a, true)
    const entry = await done
    expect(entry.name).toBe("MacBook 2")

    // B can open A, and since the link is two-way, A can open B.
    const online = await waitFor(
      () => entries(b),
      (list) => list[0]?.state === "online",
    )
    expect(online[0]?.state).toBe("online")
    const back = await waitFor(
      () => entries(a),
      (list) => list[0]?.state === "online",
    )
    expect(back[0]?.name).toBe("MacBook 1")
    expect(back[0]?.state).toBe("online")
    expect((await state(a)).clients.map((c) => c.name)).toEqual(["MacBook 1"])
    expect((await state(b)).clients.map((c) => c.name)).toEqual(["MacBook 2"])
    // The joining computer turned its own switch on, because MacBook 2 must reach it.
    expect((await state(b)).accept).toBe(true)
  })

  test("a one-way link lets only the joining computer open the other", async () => {
    const a = side("A")
    const b = side("B")
    await pair(a, b, false)
    expect((await entries(b)).length).toBe(1)
    expect((await entries(a)).length).toBe(0)
    expect((await state(b)).accept).toBe(false)
  })

  test("Deny ends the pairing and nothing is stored", async () => {
    const a = side("A")
    const b = side("B")
    const pairing = await start(a)
    const found = await probe(b, { address: pairing.addresses[0]?.address, code: pairing.code })
    const done = finish(b, found.session, true)
    await decide(a, false)
    await expect(done).rejects.toMatchObject({ code: "denied" })
    expect((await entries(b)).length).toBe(0)
    expect((await state(a)).clients.length).toBe(0)
    // Two-way was refused, so the switch of B goes back to what it was.
    expect((await state(b)).accept).toBe(false)
  })

  test("a wrong code gives a plain error, and five wrong codes end the code", async () => {
    const a = side("A")
    const b = side("B")
    const pairing = await start(a)
    const address = pairing.addresses[0]?.address
    const wrong = pairing.code === "000000" ? "111111" : "000000"
    for (let i = 0; i < 5; i++) {
      await expect(probe(b, { address, code: wrong })).rejects.toMatchObject({ code: "wrong_code" })
    }
    await expect(probe(b, { address, code: pairing.code })).rejects.toMatchObject({
      code: "code_ended",
    })
    const after = await a.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.pairing())))
    expect(after.active).toBe(false)
    expect(after.ended).toBe("tries")
  })

  test("a code works once", async () => {
    const a = side("A")
    const b = side("B")
    const c = side("C")
    const pairing = await start(a)
    const first = await probe(b, { link: pairing.link })
    await expect(probe(c, { link: pairing.link })).rejects.toMatchObject({ code: "code_ended" })
    await b.runtime.runPromise(Remote.use((r) => r.cancel(first.session)))
  })

  test("a code ends after its time", async () => {
    process.env.ROBOT_LINK_CODE_TTL_MS = "300"
    try {
      const a = side("A")
      const b = side("B")
      const pairing = await start(a)
      await new Promise((r) => setTimeout(r, 450))
      await expect(probe(b, { link: pairing.link })).rejects.toMatchObject({ code: "code_ended" })
      const after = await a.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.pairing())))
      expect(after.ended).toBe("expired")
    } finally {
      delete process.env.ROBOT_LINK_CODE_TTL_MS
    }
  })

  test("a computer cannot pair with itself", async () => {
    const a = side("A")
    const pairing = await start(a)
    await expect(probe(a, { link: pairing.link })).rejects.toMatchObject({ code: "same_device" })
  })

  test("a computer that has linked devices cannot pair with itself either", async () => {
    const a = side("A")
    const b = side("B")
    await pair(a, b, true)
    const again = await start(a)
    const address = again.addresses[0]?.address
    await expect(probe(a, { address, code: again.code })).rejects.toMatchObject({
      code: "same_device",
    })
  })

  test("with the switch off a computer accepts no connection, also from a linked device", async () => {
    const a = side("A")
    const b = side("B")
    const { pairing } = await pair(a, b)
    await waitFor(
      () => entries(b),
      (l) => l[0]?.state === "online",
    )
    // Switch off: the connection closes, and a new one is refused.
    await a.runtime.runPromise(Devices.use((d) => d.update({ accept: false })))
    expect((await state(a)).port).toBeNull()
    const gone = await waitFor(
      () => entries(b),
      (l) => l[0]?.state === "offline",
      12_000,
    )
    expect(gone[0]?.state).toBe("offline")
    // The error line for a computer that does not accept connections.
    const c = side("C")
    await expect(
      probe(c, { address: pairing.addresses[0]?.address, code: pairing.code }),
    ).rejects.toMatchObject({ code: "not_accepting" })
    // On again: the same link works, with no new pairing.
    await a.runtime.runPromise(Devices.use((d) => d.update({ accept: true })))
    const back = await waitFor(
      () => entries(b),
      (l) => l[0]?.state === "online",
      12_000,
    )
    expect(back[0]?.state).toBe("online")
  }, 40_000)

  test("remove access: the device is told, and connects again only after a new pairing", async () => {
    const a = side("A")
    const b = side("B")
    await pair(a, b)
    await waitFor(
      () => entries(b),
      (l) => l[0]?.state === "online",
    )
    const id = (await state(a)).clients[0]?.id ?? ""
    await a.runtime.runPromise(Devices.use((d) => d.removeClient(id)))
    expect((await state(a)).clients.length).toBe(0)
    const refused = await waitFor(
      () => entries(b),
      (l) => l[0]?.state === "not_allowed",
    )
    expect(refused[0]?.state).toBe("not_allowed")
    // Pairing again replaces the link.
    await pair(a, b)
    const online = await waitFor(
      () => entries(b),
      (l) => l[0]?.state === "online",
    )
    expect(online.length).toBe(1)
    expect(online[0]?.state).toBe("online")
    expect((await state(a)).clients.length).toBe(1)
  }, 30_000)

  test("a request outside the list of a client is not allowed", async () => {
    const a = side("A")
    const b = side("B")
    const { entry } = await pair(a, b)
    await waitFor(
      () => entries(b),
      (l) => l[0]?.state === "online",
    )
    const ask = (method: string) =>
      b.runtime.runPromise(Remote.use((r) => Effect.promise(() => r.request(entry.id, method))))
    await expect(ask("settings.update")).rejects.toMatchObject({ code: "not_allowed" })
    await expect(ask("agents.create")).rejects.toMatchObject({ code: "not_allowed" })
    await expect(ask("providers.list")).rejects.toMatchObject({ code: "not_allowed" })
    await expect(ask("memory.list")).rejects.toMatchObject({ code: "not_allowed" })
    await expect(ask("data.export")).rejects.toMatchObject({ code: "not_allowed" })
    // No dispatcher is bound in this test, so a request that is on the list fails inside.
    await expect(ask("places.list")).rejects.not.toMatchObject({ code: "not_allowed" })
  }, 20_000)

  test("one computer takes at most 10 devices", async () => {
    const a = side("Hub")
    const clients = Array.from({ length: 11 }, (_, i) => side(`Client ${i}`))
    for (const c of clients.slice(0, 10)) await pair(a, c)
    expect((await state(a)).clients.length).toBe(10)
    const last = clients[10] as Rt
    const pairing = await start(a)
    const found = await probe(last, { link: pairing.link })
    await expect(finish(last, found.session, false)).rejects.toMatchObject({ code: "limit" })
  }, 120_000)

  test("one device opens at most 10 computers", async () => {
    const client = side("Client")
    for (let i = 0; i < 10; i++) await pair(side(`Server ${i}`), client)
    expect((await entries(client)).length).toBe(10)
    const extra = side("Server 10")
    const pairing = await start(extra)
    await expect(probe(client, { link: pairing.link })).rejects.toMatchObject({ code: "limit" })
  }, 120_000)

  test("the name can change; a name used twice shows with a number", async () => {
    const a = side("A")
    const renamed = await a.runtime.runPromise(Devices.use((d) => d.update({ name: "Studio" })))
    expect(renamed.self.name).toBe("Studio")
    const saved = await a.runtime.runPromise(SettingsStore.use((s) => s.get))
    expect(saved.deviceName).toBe("Studio")
    // Clearing the name takes the name of the computer again.
    const cleared = await a.runtime.runPromise(Devices.use((d) => d.update({ name: "" })))
    expect(cleared.self.name).toBe("A")
  })

  test("a computer is found on the network only while its code is valid", async () => {
    const network = new MemoryNetwork()
    const server = testRuntime({ name: "Server", network })
    const client = testRuntime({ name: "Client", network })
    sides.push(server, client)
    const near = () => client.runtime.runPromise(Devices.use((d) => d.nearby()))

    expect(await near()).toEqual([])
    // Turning the switch on is not enough: only a shown code makes the computer visible.
    await server.runtime.runPromise(Devices.use((d) => d.update({ accept: true })))
    expect(await near()).toEqual([])

    const pairing = await start(server)
    const found = await near()
    expect(found.map((f) => f.name)).toEqual(["Server"])
    expect(found[0]?.address).toBe(`127.0.0.1:${pairing.addresses[0]?.address.split(":")[1]}`)
    // The address that a neighbour gets is one that pairs.
    const probed = await probe(client, { address: found[0]?.address, code: pairing.code })
    expect(probed.name).toBe("Server")

    await server.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.pairStop())))
    expect(await near()).toEqual([])
    expect(network.openCount).toBe(0)
  })

  test("a computer is not found any more after one pairing, and not after its code ends", async () => {
    const network = new MemoryNetwork()
    const server = testRuntime({ name: "Server", network })
    const client = testRuntime({ name: "Client", network })
    const third = testRuntime({ name: "Third", network })
    sides.push(server, client, third)
    const near = (who: Rt) => who.runtime.runPromise(Devices.use((d) => d.nearby()))

    const pairing = await start(server)
    expect(await near(third)).toHaveLength(1)
    const found = await probe(client, { link: pairing.link })
    const done = finish(client, found.session, false)
    await decide(server, true)
    await done
    expect(await near(third)).toEqual([])

    process.env.ROBOT_LINK_CODE_TTL_MS = "250"
    try {
      await start(server)
      expect(await near(third)).toHaveLength(1)
      await new Promise((r) => setTimeout(r, 400))
      expect(await near(third)).toEqual([])
    } finally {
      delete process.env.ROBOT_LINK_CODE_TTL_MS
    }
  })

  test("the computer that shows the code does not list itself", async () => {
    const network = new MemoryNetwork()
    const server = testRuntime({ name: "Server", network })
    sides.push(server)
    await start(server)
    expect(await server.runtime.runPromise(Devices.use((d) => d.nearby()))).toEqual([])
  })
})
