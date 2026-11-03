import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isHostMethod, makeHost } from "./Host.ts"

/**
 * Writes a stand-in host program in a new folder and returns the command that runs it with Bun.
 * The source gets the folder, for files that the program leaves for the test.
 */
const fakeHost = (source: (dir: string) => string) => {
  const dir = mkdtempSync(join(tmpdir(), "robot-host-unit-"))
  const file = join(dir, "host.ts")
  writeFileSync(file, source(dir))
  return { command: process.execPath, args: [file], dir }
}

/** Reads requests, keeps two, and answers them in the other order with what it was sent. */
const echoTwoReversed = `
import { createInterface } from "node:readline"
const held = []
createInterface({ input: process.stdin }).on("line", (line) => {
  held.push(JSON.parse(line))
  if (held.length < 2) return
  for (const r of held.reverse())
    process.stdout.write(JSON.stringify({ id: r.id, result: { ok: true, value: r } }) + "\\n")
  held.length = 0
})
`

test("answers find their calls by id, also in another order", async () => {
  const host = makeHost(fakeHost(() => echoTwoReversed))
  const actor = { id: "phone-1", name: "Phone" }
  const [a, b] = await Promise.all([
    host.call("app.licenses", undefined, null),
    host.call("app.licenses", { x: 1 }, actor),
  ])
  expect(a).toEqual({
    ok: true,
    value: { id: 1, method: "app.licenses", input: null, actor: null },
  })
  expect(b).toEqual({
    ok: true,
    value: { id: 2, method: "app.licenses", input: { x: 1 }, actor },
  })
  await host.close()
})

test("a host that stops fails its calls, and the next call starts it again", async () => {
  const spec = fakeHost(
    (dir) => `
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(join(dir, "starts"))}, "start\\n")
process.exit(3)
`,
  )
  const host = makeHost(spec)
  const failed = {
    ok: false as const,
    error: { code: "host_unavailable", message: "The host is not running" },
  }
  expect(await host.call("app.licenses", undefined, null)).toEqual(failed)
  expect(await host.call("app.licenses", undefined, null)).toEqual(failed)
  expect(readFileSync(join(spec.dir, "starts"), "utf8")).toBe("start\nstart\n")
  await host.close()
})

test("a program that cannot run fails the call and does not throw", async () => {
  const host = makeHost({ command: join(tmpdir(), "no-such-robot-host"), args: [] })
  const result = await host.call("app.licenses", undefined, null)
  expect(result.ok).toBe(false)
  await host.close()
})

test("close ends the host through its input, and later calls fail at once", async () => {
  const spec = fakeHost(
    (dir) => `
import { writeFileSync } from "node:fs"
process.stdin.on("data", () => {})
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(join(dir, "ended"))}, "")
  process.exit(0)
})
`,
  )
  const host = makeHost(spec)
  void host.call("app.licenses", undefined, null)
  expect(host.pid()).toBeNumber()
  await host.close()
  expect(existsSync(join(spec.dir, "ended"))).toBe(true)
  const late = await host.call("app.licenses", undefined, null)
  expect(late.ok).toBe(false)
})

test("only the listed methods go to the host", () => {
  expect(isHostMethod("app.licenses")).toBe(true)
  expect(isHostMethod("app.info")).toBe(false)
})
