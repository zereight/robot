import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { freePort, tcpIsFree } from "../../e2e/ports.ts"

// This test lives here and not next to `ports.ts`: Playwright runs every `*.test.ts` under
// `e2e/`, while `bun test` runs this folder, so only here does the check run in CI.

// `freePort` must never hand out a number that another program of this computer holds on an IPv4
// address: a test that connects to 127.0.0.1 and that number would reach the other program. The
// bind probe of `ports.ts` listens on all addresses, which misses a holder on 127.0.0.1 or on all
// IPv4 addresses, so its connect check must catch those.

describe("tcpIsFree", () => {
  test("a port held on 127.0.0.1 or on all IPv4 addresses reads as used", async () => {
    const onLoopback = createServer((socket) => socket.end())
    const onAll = createServer((socket) => socket.end())
    await new Promise<void>((done) => onLoopback.listen(0, "127.0.0.1", done))
    await new Promise<void>((done) => onAll.listen(0, "0.0.0.0", done))
    try {
      expect(await tcpIsFree((onLoopback.address() as { port: number }).port)).toBe(false)
      expect(await tcpIsFree((onAll.address() as { port: number }).port)).toBe(false)
    } finally {
      await new Promise<void>((done) => onLoopback.close(() => done()))
      await new Promise<void>((done) => onAll.close(() => done()))
    }
  })

  test("a port that nothing holds reads as free", async () => {
    const holder = createServer()
    await new Promise<void>((done) => holder.listen(0, "127.0.0.1", done))
    const port = (holder.address() as { port: number }).port
    await new Promise<void>((done) => holder.close(() => done()))
    expect(await tcpIsFree(port)).toBe(true)
  })
})

describe("freePort", () => {
  test("hands out a number in range that nothing holds", async () => {
    const port = await freePort()
    expect(port).toBeGreaterThanOrEqual(20_000)
    expect(port).toBeLessThanOrEqual(31_999)
    const holder = createServer()
    await new Promise<void>((done) => holder.listen(port, "127.0.0.1", done))
    await new Promise<void>((done) => holder.close(() => done()))
  })
})
