import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { type FakeRuntimes, makeFakeRuntimes, sha256, tarGzOf } from "../../../e2e/fake-runtimes.ts"
import { Providers } from "./Providers.ts"
import { Runtimes } from "./Runtimes.ts"
import { Secrets } from "./Secrets.ts"
import { testRuntime } from "./testing.ts"

let fake: FakeRuntimes
const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  fake = makeFakeRuntimes()
  for (const key of ["ROBOT_CLAUDE_BIN", "ROBOT_CODEX_BIN", "ROBOT_MUSE_BIN"])
    saved[key] = process.env[key]
  process.env.ROBOT_CLAUDE_BIN = fake.claude
  process.env.ROBOT_CODEX_BIN = fake.codex
  process.env.ROBOT_MUSE_BIN = fake.muse
})
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const code = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

describe("runtime accounts", () => {
  test("a signed in program connects; no key is kept; the models are the program's", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const account = await t.runtime.runPromise(
      Providers.use((p) =>
        p.connect({
          kind: "claude_code",
          name: "Claude",
          baseUrl: "http://ignored.example",
          apiKey: "ignored",
        }),
      ),
    )
    expect(account).toMatchObject({ kind: "claude_code", connected: true, baseUrl: "" })
    const models = await t.runtime.runPromise(Providers.use((p) => p.models(account.id)))
    expect(models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku"])
    const secrets = await t.runtime.runPromise(Secrets.use((s) => Effect.succeed(s)))
    expect(secrets.get(`provider:${account.id}`)).toBeNull()
    const status = await t.runtime.runPromise(Runtimes.use((r) => r.status("claude_code")))
    expect(status).toMatchObject({ source: "system", version: "9.9.9", user: "a@b.c", plan: "max" })
  })

  test("the usage windows are read after the look; a failed read keeps the last ones", async () => {
    const usage = {
      five_hour: { utilization: 30, resets_at: "2099-01-01T00:00:00Z" },
      seven_day: { utilization: 60, resets_at: "2099-01-02T00:00:00Z" },
    }
    const reads = () => fake.claudeUsageCalls().filter((c) => c.kind === "usage").length
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max", usage })
    const t = testRuntime()
    const first = await t.runtime.runPromise(Runtimes.use((r) => r.status("claude_code")))
    // The look does not wait for the windows.
    expect(first).toMatchObject({ signedIn: true, plan: "max" })
    await until(
      () =>
        t.runtime.runSync(Runtimes.use((r) => Effect.sync(() => r.cached("claude_code")))).limits
          .length === 2,
    )
    const read = t.runtime.runSync(Runtimes.use((r) => Effect.sync(() => r.cached("claude_code"))))
    expect(read.limits.map((l) => [l.window, l.used])).toEqual([
      ["five_hour", 0.3],
      ["seven_day", 0.6],
    ])
    expect(read.limitsAt).toBeGreaterThan(Date.now() - 5000)

    // The vendor tells nothing the next time: the windows stay, with the time they were read.
    const before = reads()
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    await t.runtime.runPromise(Runtimes.use((r) => r.status("claude_code")))
    await until(() => reads() > before)
    await Bun.sleep(300)
    const kept = t.runtime.runSync(Runtimes.use((r) => Effect.sync(() => r.cached("claude_code"))))
    expect(kept.limits).toEqual(read.limits)
    expect(kept.limitsAt).toBe(read.limitsAt)
  })

  test("no windows are asked of a program that is signed out or signed in with a key", async () => {
    const reads = () => fake.claudeUsageCalls().filter((c) => c.kind === "usage").length
    const before = reads()
    fake.setClaude({ loggedIn: true, authMethod: "console" })
    const t = testRuntime()
    await t.runtime.runPromise(Runtimes.use((r) => r.status("claude_code")))
    fake.setClaude({ loggedIn: false })
    await t.runtime.runPromise(Runtimes.use((r) => r.status("claude_code")))
    await Bun.sleep(300)
    expect(reads()).toBe(before)
  })

  test("a program that is signed out, or signed in with a key, or missing, is refused", async () => {
    const t = testRuntime()
    const connect = (kind: "claude_code" | "codex") =>
      t.runtime.runPromiseExit(Providers.use((p) => p.connect({ kind, name: "X" })))
    fake.setClaude({ loggedIn: false })
    expect(code(await connect("claude_code"))).toBe("runtime_not_signed_in")
    fake.setClaude({ loggedIn: true, authMethod: "console" })
    expect(code(await connect("claude_code"))).toBe("runtime_api_key_login")
    fake.setCodex({ loggedIn: true, method: "key" })
    expect(code(await connect("codex"))).toBe("runtime_api_key_login")
    process.env.ROBOT_CODEX_BIN = "/no/such/codex"
    try {
      expect(
        code(
          await testRuntime().runtime.runPromiseExit(
            Providers.use((p) => p.connect({ kind: "codex", name: "X" })),
          ),
        ),
      ).toBe("runtime_missing")
    } finally {
      process.env.ROBOT_CODEX_BIN = fake.codex
    }
    expect(await t.runtime.runPromise(Providers.use((p) => p.list))).toHaveLength(0)
  })

  test("disconnect switches the account off but leaves the program signed in", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const account = await t.runtime.runPromise(
      Providers.use((p) => p.connect({ kind: "claude_code", name: "Claude" })),
    )
    await t.runtime.runPromise(Providers.use((p) => p.disconnect(account.id)))
    const [off] = await t.runtime.runPromise(Providers.use((p) => p.list))
    expect(off?.connected).toBe(false)
    expect(await t.runtime.runPromise(Providers.use((p) => p.verify(account.id)))).toBe(false)
    // The program itself was not signed out.
    const direct = await Bun.$`${fake.claude} auth status`.text()
    expect(JSON.parse(direct).loggedIn).toBe(true)
    await t.runtime.runPromise(Providers.use((p) => p.check(account.id)))
    expect((await t.runtime.runPromise(Providers.use((p) => p.list)))[0]?.connected).toBe(true)
  })

  test("an account shows as not connected after the user signs out in the program", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const account = await t.runtime.runPromise(
      Providers.use((p) => p.connect({ kind: "claude_code", name: "Claude" })),
    )
    fake.setClaude({ loggedIn: false })
    await t.runtime.runPromise(Runtimes.use((r) => r.status("claude_code")))
    expect((await t.runtime.runPromise(Providers.use((p) => p.list)))[0]?.connected).toBe(false)
    expect(await t.runtime.runPromise(Providers.use((p) => p.verify(account.id)))).toBe(false)
  })

  test("the sign-in of the program can be done from the app", async () => {
    fake.setClaude({ loggedIn: false })
    process.env.FAKE_LOGIN_MS = "50"
    const t = testRuntime()
    try {
      const status = await t.runtime.runPromise(Runtimes.use((r) => r.signIn("claude_code")))
      expect(status).toMatchObject({
        signedIn: true,
        method: "subscription",
        busy: null,
        problem: null,
      })
    } finally {
      delete process.env.FAKE_LOGIN_MS
    }
  })

  test("a sign-in that fails tells why; a cancel ends it quietly", async () => {
    fake.setClaude({ loggedIn: false, loginFails: true })
    process.env.FAKE_LOGIN_MS = "50"
    const t = testRuntime()
    try {
      const failed = await t.runtime.runPromise(Runtimes.use((r) => r.signIn("claude_code")))
      expect(failed.signedIn).toBe(false)
      expect(failed.problem).toBe("Login failed")
      process.env.FAKE_LOGIN_MS = "5000"
      fake.setClaude({ loggedIn: false })
      const pending = t.runtime.runPromise(Runtimes.use((r) => r.signIn("claude_code")))
      await until(
        async () =>
          (await t.runtime.runPromise(
            Runtimes.use((r) => Effect.sync(() => r.cached("claude_code").busy)),
          )) === "signing_in",
      )
      await Bun.sleep(100)
      await t.runtime.runPromise(Runtimes.use((r) => r.cancel("claude_code")))
      const done = await pending
      expect(done).toMatchObject({ signedIn: false, busy: null, problem: null })
    } finally {
      delete process.env.FAKE_LOGIN_MS
    }
  })
})

const SEPARATE = "11111111-2222-3333-4444-555555555555"
const ANOTHER = "66666666-7777-8888-9999-000000000000"

describe("separate sign-ins", () => {
  const folder = (dataDir: string, id: string) => join(dataDir, "sign-ins", "claude_code", id)
  const withLogin = async <T>(task: () => Promise<T>) => {
    process.env.FAKE_LOGIN_MS = "50"
    try {
      return await task()
    } finally {
      delete process.env.FAKE_LOGIN_MS
    }
  }

  test("a separate sign-in has its own state and its own folder, and the program's own stays", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const run = t.runtime.runPromise
    // Nobody is signed in there yet, and looking makes no folder.
    const before = await run(Runtimes.use((r) => r.status("claude_code", SEPARATE)))
    expect(before).toMatchObject({ signIn: SEPARATE, signedIn: false, source: "system" })
    expect(existsSync(folder(t.dataDir, SEPARATE))).toBe(false)

    const after = await withLogin(() => run(Runtimes.use((r) => r.signIn("claude_code", SEPARATE))))
    expect(after).toMatchObject({
      signIn: SEPARATE,
      signedIn: true,
      method: "subscription",
      user: "second@example.com",
      plan: "pro",
      busy: null,
      problem: null,
    })
    // The program was told to keep the sign-in in the folder of the account.
    const login = fake.claudeCalls().filter((c) => c.kind === "login" && c.configDir !== null)
    expect(login.at(-1)?.configDir).toBe(folder(t.dataDir, SEPARATE))
    // The sign-in of the computer did not change.
    const own = await run(Runtimes.use((r) => r.status("claude_code")))
    expect(own).toMatchObject({ signIn: null, user: "a@b.c", plan: "max" })
    expect(
      await run(Runtimes.use((r) => Effect.sync(() => r.ready("claude_code", SEPARATE)))),
    ).toBe(true)
    expect(await Bun.$`${fake.claude} auth status`.text()).toContain("a@b.c")
  })

  test("two accounts of one program are looked at, and run, each with its own sign-in", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const run = t.runtime.runPromise
    await withLogin(() => run(Runtimes.use((r) => r.signIn("claude_code", SEPARATE))))
    const first = await run(Providers.use((p) => p.connect({ kind: "claude_code", name: "Home" })))
    const second = await run(
      Providers.use((p) => p.connect({ kind: "claude_code", name: "Work", signIn: SEPARATE })),
    )
    expect(first).toMatchObject({ signIn: null, connected: true })
    expect(second).toMatchObject({ signIn: SEPARATE, connected: true })

    const list = await run(Providers.use((p) => p.list))
    expect(list.map((a) => [a.name, a.runtime?.user, a.runtime?.plan])).toEqual([
      ["Home", "a@b.c", "max"],
      ["Work", "second@example.com", "pro"],
    ])

    // One account is signed out: only that account shows as not connected.
    rmSync(join(folder(t.dataDir, SEPARATE), "fake-state.json"))
    await run(Runtimes.use((r) => r.status("claude_code", SEPARATE)))
    const later = await run(Providers.use((p) => p.list))
    expect(later.map((a) => [a.name, a.connected])).toEqual([
      ["Home", true],
      ["Work", false],
    ])
  })

  test("a sign-in is for a program that can have one, and it must be signed in", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    fake.setCodex({ loggedIn: true, method: "chatgpt" })
    const t = testRuntime()
    const connect = (input: Parameters<(typeof Providers.Service)["connect"]>[0]) =>
      t.runtime.runPromiseExit(Providers.use((p) => p.connect(input)))
    expect(code(await connect({ kind: "codex", name: "X", signIn: SEPARATE }))).toBe(
      "invalid_input",
    )
    expect(code(await connect({ kind: "openai", name: "X", signIn: SEPARATE }))).toBe(
      "invalid_input",
    )
    // Nobody signed in to that folder: the program of the computer does not stand in for it.
    expect(code(await connect({ kind: "claude_code", name: "X", signIn: SEPARATE }))).toBe(
      "runtime_not_signed_in",
    )
    expect(await t.runtime.runPromise(Providers.use((p) => p.list))).toHaveLength(0)
  })

  test("connecting an account again keeps its sign-in", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const run = t.runtime.runPromise
    await withLogin(() => run(Runtimes.use((r) => r.signIn("claude_code", SEPARATE))))
    const work = await run(
      Providers.use((p) => p.connect({ kind: "claude_code", name: "Work", signIn: SEPARATE })),
    )
    const again = await run(
      Providers.use((p) =>
        p.connect({ accountId: work.id, kind: "claude_code", name: "Work 2", signIn: ANOTHER }),
      ),
    )
    expect(again).toMatchObject({ id: work.id, name: "Work 2", signIn: SEPARATE })
  })

  test("removing an account signs its sign-in out and deletes the folder; the computer's stays", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const run = t.runtime.runPromise
    await withLogin(() => run(Runtimes.use((r) => r.signIn("claude_code", SEPARATE))))
    const home = await run(Providers.use((p) => p.connect({ kind: "claude_code", name: "Home" })))
    const work = await run(
      Providers.use((p) => p.connect({ kind: "claude_code", name: "Work", signIn: SEPARATE })),
    )
    expect(existsSync(folder(t.dataDir, SEPARATE))).toBe(true)
    await run(Providers.use((p) => p.remove(work.id)))
    expect(existsSync(folder(t.dataDir, SEPARATE))).toBe(false)
    expect(
      fake
        .claudeCalls()
        .some((c) => c.kind === "logout" && c.configDir === folder(t.dataDir, SEPARATE)),
    ).toBe(true)
    // The account of the computer was not signed out, and no sign-out ran without a folder.
    expect(fake.claudeCalls().some((c) => c.kind === "logout" && c.configDir === null)).toBe(false)
    expect(await Bun.$`${fake.claude} auth status`.text()).toContain("a@b.c")
    const [left] = await run(Providers.use((p) => p.list))
    expect(left).toMatchObject({ id: home.id, connected: true })
    // Removing the account of the computer leaves the program signed in.
    await run(Providers.use((p) => p.remove(home.id)))
    expect(await Bun.$`${fake.claude} auth status`.text()).toContain("a@b.c")
  })

  test("a sign-in that the user gave up is removed, but one that an account uses is not", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const run = t.runtime.runPromise
    await withLogin(async () => {
      await run(Runtimes.use((r) => r.signIn("claude_code", SEPARATE)))
      await run(Runtimes.use((r) => r.signIn("claude_code", ANOTHER)))
    })
    await run(
      Providers.use((p) => p.connect({ kind: "claude_code", name: "Work", signIn: SEPARATE })),
    )
    await run(Providers.use((p) => p.discardSignIn("claude_code", SEPARATE)))
    await run(Providers.use((p) => p.discardSignIn("claude_code", ANOTHER)))
    expect(existsSync(folder(t.dataDir, SEPARATE))).toBe(true)
    expect(existsSync(folder(t.dataDir, ANOTHER))).toBe(false)
  })

  test("an id that is not a plain name cannot reach another folder", async () => {
    const t = testRuntime()
    const outcome = await t.runtime.runPromiseExit(
      Runtimes.use((r) => r.status("claude_code", "../../etc")),
    )
    expect(Exit.isFailure(outcome)).toBe(true)
  })
})

describe("download", () => {
  test("a missing program is downloaded, checked, found and used", async () => {
    fake.setCodex({ loggedIn: true, method: "chatgpt" })
    const archive = tarGzOf("codex-release", readFileSync(fake.codex, "utf8"))
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/repos/openai/codex/releases/latest") {
          const name =
            process.platform === "darwin"
              ? `codex-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`
              : `codex-${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl.tar.gz`
          return Response.json({
            tag_name: "rust-v9.9.9",
            assets: [
              {
                name,
                size: archive.length,
                digest: `sha256:${sha256(archive)}`,
                browser_download_url: `${url.origin}/download/${name}`,
              },
            ],
          })
        }
        if (url.pathname.startsWith("/download/")) return new Response(archive)
        return new Response("no", { status: 404 })
      },
    })
    process.env.ROBOT_CODEX_BIN = "none"
    process.env.ROBOT_CODEX_API = `http://127.0.0.1:${server.port}`
    try {
      const t = testRuntime()
      const missing = await t.runtime.runPromise(Runtimes.use((r) => r.status("codex")))
      expect(missing).toMatchObject({ source: null, version: null })
      const done = await t.runtime.runPromise(Runtimes.use((r) => r.install("codex")))
      expect(done.problem).toBeNull()
      expect(done).toMatchObject({ source: "app", version: "9.9.9", signedIn: true, busy: null })
      const account = await t.runtime.runPromise(
        Providers.use((p) => p.connect({ kind: "codex", name: "Codex" })),
      )
      expect(account.connected).toBe(true)
    } finally {
      process.env.ROBOT_CODEX_BIN = fake.codex
      delete process.env.ROBOT_CODEX_API
      server.stop()
    }
  })
})

describe("runtime states (spec 006)", () => {
  /** A program of its own that runs the stand-in, so a test can remove it, or make it fail. */
  const wrapped = (flag?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "robot-wrap-"))
    const path = join(dir, "codex")
    const body = `#!/bin/sh\n${flag ? `[ -f "${flag}" ] && exec /no/such/program\n` : ""}exec "${fake.codex}" "$@"\n`
    const put = () => {
      writeFileSync(path, body)
      chmodSync(path, 0o755)
    }
    put()
    return { dir, path, put }
  }
  const using = async <T>(
    bin: string,
    task: () => Promise<T>,
    extra: Record<string, string> = {},
  ) => {
    const before = { bin: process.env.ROBOT_CODEX_BIN, ms: process.env.ROBOT_CHECK_MS }
    process.env.ROBOT_CODEX_BIN = bin
    Object.assign(process.env, extra)
    try {
      return await task()
    } finally {
      process.env.ROBOT_CODEX_BIN = before.bin
      if (before.ms === undefined) delete process.env.ROBOT_CHECK_MS
      else process.env.ROBOT_CHECK_MS = before.ms
    }
  }
  const look = (t: ReturnType<typeof testRuntime>) =>
    t.runtime.runPromise(Runtimes.use((r) => r.status("codex")))
  const signedIn = { loggedIn: true, method: "chatgpt" }

  test("a program that was never found is Not installed", async () => {
    fake.setCodex(signedIn)
    await using("/no/such/codex", async () => {
      const state = await look(testRuntime())
      expect(state).toMatchObject({ state: "not_installed", reason: null, busy: null })
      expect(state.checkedAt).toBeGreaterThan(0)
    })
  })

  test("a program that answers and is signed in is Ready, with the time of the check", async () => {
    fake.setCodex(signedIn)
    const before = Date.now()
    const state = await look(testRuntime())
    expect(state).toMatchObject({ state: "ready", reason: null, signedIn: true })
    expect(state.checkedAt).toBeGreaterThanOrEqual(before)
  })

  test("a program that is signed out Needs sign-in", async () => {
    fake.setCodex({ loggedIn: false })
    expect(await look(testRuntime())).toMatchObject({ state: "needs_sign_in", reason: null })
  })

  test("Check again asks only for the version and the sign-in state: no turn, no sign-in change", async () => {
    fake.setCodex(signedIn)
    const t = testRuntime()
    const asked = fake.asks("codex").length
    const turns = fake.codexCalls().length
    await look(t)
    await look(t)
    const calls = fake.asks("codex").slice(asked)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect([["--version"], ["login", "status"]]).toContainEqual(call)
    expect(fake.codexCalls()).toHaveLength(turns)
  })

  test("a program that was found and is gone Needs repair; Repair finds it again and leaves the sign-in alone", async () => {
    fake.setCodex(signedIn)
    const program = wrapped()
    await using(program.path, async () => {
      const t = testRuntime()
      expect(await look(t)).toMatchObject({ state: "ready" })
      rmSync(program.path)
      expect(await look(t)).toMatchObject({ state: "needs_repair", reason: "gone" })
      // A look that is not "Repair" does not bring it back.
      expect(await look(t)).toMatchObject({ state: "needs_repair", reason: "gone" })
      program.put()
      const asked = fake.asks("codex").length
      const fixed = await t.runtime.runPromise(Runtimes.use((r) => r.repair("codex")))
      expect(fixed).toMatchObject({ state: "ready", reason: null, busy: null, problem: null })
      // Repair checks. It signs nothing in and nothing out.
      for (const call of fake.asks("codex").slice(asked))
        expect([["--version"], ["login", "status"]]).toContainEqual(call)
      expect(JSON.parse(readFileSync(join(fake.dir, "codex-state.json"), "utf8"))).toEqual(signedIn)
    })
  })

  test("a program that exits at start, or gives an answer with no version, Needs repair, each with its reason", async () => {
    const t = testRuntime()
    fake.setCodex({ ...signedIn, exitAtStart: true })
    expect(await look(t)).toMatchObject({ state: "needs_repair", reason: "start" })
    fake.setCodex({ ...signedIn, garbage: true })
    expect(await look(t)).toMatchObject({ state: "needs_repair", reason: "unreadable" })
    fake.setCodex(signedIn)
    expect(await look(t)).toMatchObject({ state: "ready" })
  })

  test("a program that does not answer ends the check in a state, within the limit", async () => {
    fake.setCodex({ ...signedIn, hang: 1_500 })
    const t = testRuntime()
    await using(
      fake.codex,
      async () => {
        const started = Date.now()
        const running = look(t)
        // While the check runs, the row shows Checking.
        await Bun.sleep(30)
        expect(
          await t.runtime.runPromise(Runtimes.use((r) => Effect.sync(() => r.cached("codex")))),
        ).toMatchObject({ state: "checking" })
        expect(await running).toMatchObject({ state: "needs_repair", reason: "answer" })
        expect(Date.now() - started).toBeLessThan(5_000)
        // The late answer of the program does not undo the state.
        await Bun.sleep(100)
        expect(
          await t.runtime.runPromise(Runtimes.use((r) => Effect.sync(() => r.cached("codex")))),
        ).toMatchObject({ state: "needs_repair", reason: "answer" })
      },
      { ROBOT_CHECK_MS: "300" },
    )
  })
})

describe("the level Read only on a vendor program (spec 007)", () => {})
