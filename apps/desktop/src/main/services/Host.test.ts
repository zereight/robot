import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isHostMethod, makeHost } from "./Host.ts"

/**
 * Writes a stand-in host program in a new folder and returns the command that runs it with the
 * shell. The source gets the folder, for files that the program leaves for the test. It is a shell
 * script, not a program of Bun: when many test files start Bun programs at once, some of them do
 * not start for seconds, or never, and the test waits for its time limit.
 */
const fakeHost = (source: (dir: string) => string) => {
  const dir = mkdtempSync(join(tmpdir(), "robot-host-unit-"))
  const file = join(dir, "host.sh")
  writeFileSync(file, source(dir))
  return { command: "/bin/sh", args: [file], dir }
}

/**
 * Reads two requests and answers them in the other order. An answer holds the request that it
 * answers, as the value. Then it reads until its input closes, as the host does.
 */
// `String.raw` keeps the backslashes for the shell.
const echoTwoReversed = String.raw`
read -r first
read -r second
answer() {
  id=$(printf '%s' "$1" | sed -n 's/^{"id":\([0-9]*\),.*/\1/p')
  printf '{"id":%s,"result":{"ok":true,"value":%s}}\n' "$id" "$1"
}
answer "$second"
answer "$first"
cat > /dev/null
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
echo start >> ${JSON.stringify(join(dir, "starts"))}
exit 3
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
: > ${JSON.stringify(join(dir, "started"))}
cat > /dev/null
: > ${JSON.stringify(join(dir, "ended"))}
exit 0
`,
  )
  const host = makeHost(spec)
  void host.call("app.licenses", undefined, null)
  expect(host.pid()).toBeNumber()
  // The host gets only a short time to end after its input closes, and then it is killed. A program
  // that has not started yet cannot end in that time, so the test closes the input only after
  // the program has started. On a busy computer, the start can take seconds.
  for (let i = 0; i < 3000 && !existsSync(join(spec.dir, "started")); i++) await Bun.sleep(10)
  expect(existsSync(join(spec.dir, "started"))).toBe(true)
  await host.close()
  expect(existsSync(join(spec.dir, "ended"))).toBe(true)
  const late = await host.call("app.licenses", undefined, null)
  expect(late.ok).toBe(false)
})

test("only the listed methods go to the host", () => {
  expect(isHostMethod("app.licenses")).toBe(true)
  expect(isHostMethod("app.info")).toBe(false)
})
