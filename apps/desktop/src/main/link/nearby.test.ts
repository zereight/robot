import { describe, expect, test } from "bun:test"
import { MemoryNetwork } from "./nearby.testing.ts"
import { cleanName, Nearby } from "./nearby.ts"

const FAST = 60

const advert = (over: Partial<Parameters<Nearby["advertise"]>[0]> = {}) => ({
  id: "aaaa1111",
  name: "MacBook 2",
  port: 47800,
  hosts: ["192.168.1.20"],
  ...over,
})

describe("computers near", () => {
  test("a computer that shows a code is found with its name and address", async () => {
    const net = new MemoryNetwork()
    const server = new Nearby(net.open)
    server.advertise(advert())
    const client = new Nearby(net.open)
    expect(await client.find("bbbb2222", FAST)).toEqual([
      { name: "MacBook 2", address: "192.168.1.20:47800" },
    ])
    server.stop()
  })

  test("nobody is found before an advert and after it stops, and a stop tells the neighbours", async () => {
    const net = new MemoryNetwork()
    const server = new Nearby(net.open)
    const client = new Nearby(net.open)
    expect(await client.find("bbbb2222", FAST)).toEqual([])
    server.advertise(advert())
    expect(await client.find("bbbb2222", FAST)).toHaveLength(1)
    server.stop()
    expect(server.advertising).toBe(false)
    const goodbye = net.sent
      .filter((s) => s.kind === "response")
      .at(-1)
      ?.packet.answers?.map((a) => a.ttl)
    expect(goodbye?.every((ttl) => ttl === 0)).toBe(true)
    expect(await client.find("bbbb2222", FAST)).toEqual([])
    expect(net.openCount).toBe(0)
  })

  test("a computer does not find itself", async () => {
    const net = new MemoryNetwork()
    const me = new Nearby(net.open)
    me.advertise(advert())
    expect(await me.find("aaaa1111", FAST)).toEqual([])
    me.stop()
  })

  test("two computers near are both listed, once each", async () => {
    const net = new MemoryNetwork()
    const one = new Nearby(net.open)
    const two = new Nearby(net.open)
    one.advertise(advert({ id: "1111", name: "Mac one", hosts: ["10.0.0.1"] }))
    two.advertise(advert({ id: "2222", name: "Mac two", hosts: ["10.0.0.2"], port: 50000 }))
    const found = await new Nearby(net.open).find("3333", FAST)
    expect(found.map((f) => f.name).sort()).toEqual(["Mac one", "Mac two"])
    expect(found.find((f) => f.name === "Mac two")?.address).toBe("10.0.0.2:50000")
    one.stop()
    two.stop()
  })

  test("a new advert replaces the old one, and only one socket stays open for it", async () => {
    const net = new MemoryNetwork()
    const server = new Nearby(net.open)
    server.advertise(advert({ name: "Old" }))
    server.advertise(advert({ name: "New" }))
    expect(net.openCount).toBe(1)
    const found = await new Nearby(net.open).find("x", FAST)
    expect(found.map((f) => f.name)).toEqual(["New"])
    server.stop()
  })

  test("no network: nothing is found and nothing throws", async () => {
    const net = new MemoryNetwork()
    net.down = true
    const server = new Nearby(net.open)
    server.advertise(advert())
    expect(server.advertising).toBe(false)
    expect(await new Nearby(net.open).find("x", FAST)).toEqual([])
  })

  test("a computer with no IPv4 address is not announced", () => {
    const net = new MemoryNetwork()
    const server = new Nearby(net.open)
    server.advertise(advert({ hosts: ["[fd00::1]"] }))
    expect(server.advertising).toBe(false)
    expect(net.openCount).toBe(0)
  })

  test("a name from the network loses control characters and is cut", () => {
    expect(cleanName("Mac\u0007book\n 2")).toBe("Mac book 2")
    expect(cleanName("x".repeat(200))).toHaveLength(60)
    expect(cleanName("  \u0000  ")).toBe("")
  })
})
