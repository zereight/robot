import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergePath, parseLoginPath, readLoginPath } from "./login-path.ts"

const dir = mkdtempSync(join(tmpdir(), "robot-login-path-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const script = (name: string, body: string) => {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe("parseLoginPath", () => {
  test("text around the marks is dropped", () => {
    expect(parseLoginPath("welcome\n__ROBOT_PATH_START__/a:/b__ROBOT_PATH_END__bye")).toBe("/a:/b")
  })

  test("no marks, or an empty PATH, is null", () => {
    expect(parseLoginPath("/a:/b")).toBeNull()
    expect(parseLoginPath("__ROBOT_PATH_START____ROBOT_PATH_END__")).toBeNull()
  })
})

describe("mergePath", () => {
  test("login folders come first and no folder is repeated", () => {
    expect(mergePath("/usr/bin:/bin", "/home/a/.nvm/bin:/usr/bin")).toBe(
      "/home/a/.nvm/bin:/usr/bin:/bin",
    )
  })

  test("a missing PATH becomes the login PATH", () => {
    expect(mergePath(undefined, "/a:/b")).toBe("/a:/b")
  })
})

describe("readLoginPath", () => {
  test("reads the PATH from a shell that prints other text too", async () => {
    if (process.platform === "win32") return
    // The fake shell does not run the command that it gets, so it prints the marks itself.
    const shell = script(
      "marked",
      `echo "motd"; printf '__ROBOT_PATH_START__/x/bin:/y/bin__ROBOT_PATH_END__'`,
    )
    expect(await readLoginPath({ shell })).toBe("/x/bin:/y/bin")
  })

  test("a real shell gives a PATH", async () => {
    if (process.platform === "win32") return
    const path = await readLoginPath({ shell: "/bin/sh" })
    expect(path?.length).toBeGreaterThan(0)
  })

  test("a shell that does not answer in time is null, and the wait is short", async () => {
    if (process.platform === "win32") return
    const slow = script("slow", "sleep 5")
    const started = Date.now()
    expect(await readLoginPath({ shell: slow, timeoutMs: 200 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("a shell that is missing is null", async () => {
    expect(await readLoginPath({ shell: join(dir, "none") })).toBeNull()
  })
})
