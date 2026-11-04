import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  type ChatMessage,
  messageText,
  type PermissionLevel,
  type ToolStepKind,
} from "@robot/shared"
import { Effect, Exit } from "effect"
import { type FakeRuntimes, makeFakeRuntimes, sha256, tarGzOf } from "../../../e2e/fake-runtimes.ts"
import { runRequest } from "../rpc.ts"
import { type Ctx, KINDS } from "../sync/kinds.ts"
import { parseOp } from "../sync/wire.ts"
import { tempDir, trackTemp } from "../test-temp.ts"
import { ActionLog } from "./ActionLog.ts"
import { Activity } from "./Activity.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Knowledge } from "./Knowledge.ts"
import { Memory } from "./Memory.ts"
import { Notifier } from "./Notifier.ts"
import { Providers } from "./Providers.ts"
import { Runtimes } from "./Runtimes.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

let fake: FakeRuntimes
const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  fake = makeFakeRuntimes()
  trackTemp(fake.dir)
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

  test("a turn of an account runs the program with the folder of that account", async () => {
    fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
    const t = testRuntime()
    const run = t.runtime.runPromise
    await withLogin(() => run(Runtimes.use((r) => r.signIn("claude_code", SEPARATE))))
    const home = await run(Providers.use((p) => p.connect({ kind: "claude_code", name: "Home" })))
    const work = await run(
      Providers.use((p) => p.connect({ kind: "claude_code", name: "Work", signIn: SEPARATE })),
    )
    const local = await run(Servers.use((s) => s.local))
    const ask = async (accountId: string, name: string, text: string) => {
      const agent = await run(
        Agents.use((a) =>
          a.create({
            serverId: local.id,
            name,
            role: "",
            instructions: "",
            model: { accountId, model: "sonnet", effort: null },
          }),
        ),
      )
      await run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
      await until(async () => {
        const last = (await run(Chat.use((c) => c.history(agent.id)))).messages
          .filter((m) => m.author === "agent")
          .at(-1)
        return last !== undefined && last.status !== "streaming"
      })
    }
    await ask(work.id, "Wendy", "from work")
    await ask(home.id, "Hank", "from home")
    const turns = fake.claudeCalls().filter((c) => typeof c.prompt === "string")
    const dirOf = (text: string) => turns.find((c) => String(c.prompt).includes(text))?.configDir
    expect(dirOf("from work")).toBe(folder(t.dataDir, SEPARATE))
    // The account of the computer sets no folder: the program uses its own place.
    expect(dirOf("from home")).toBeNull()
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

const chatSetup = async (
  kind: "claude_code" | "codex" | "muse",
  permission: PermissionLevel = "ask_risky",
) => {
  fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
  fake.setCodex({ loggedIn: true, method: "chatgpt" })
  fake.setMuse({ loggedIn: true })
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(Providers.use((p) => p.connect({ kind, name: "Sub" })))
  const local = await run(Servers.use((s) => s.local))
  const agent = await run(
    Agents.use((a) =>
      a.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "Be brief.",
        model: {
          accountId: account.id,
          model: kind === "claude_code" ? "sonnet" : "default",
          effort: null,
        },
      }),
    ),
  )
  await run(Agents.use((a) => a.update(agent.id, { permission })))
  const history = () => run(Chat.use((c) => c.history(agent.id)))
  const reply = async (): Promise<ChatMessage | undefined> =>
    (await history()).messages.filter((m) => m.author === "agent").at(-1)
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
  const settled = () =>
    until(async () => {
      const r = await reply()
      return r !== undefined && r.status !== "streaming"
    })
  const card = async () => {
    const r = await reply()
    const part = r?.parts.find((p) => p.kind === "tool")
    return part?.kind === "tool" ? part : undefined
  }
  const respond = (answer: string) =>
    run(Tools.use((x) => x.respond(agent.id, "toolu_fake1", answer)))
  return { run, t, agent, local, history, reply, send, settled, card, respond, account }
}

describe("download", () => {
  test("a missing program is downloaded, checked, found and used", async () => {
    fake.setCodex({ loggedIn: true, method: "chatgpt" })
    const archive = tarGzOf("codex-release", readFileSync(fake.codex, "utf8"))
    const server = Bun.serve({
      port: 0,
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

describe("a chat on a subscription", () => {
  test("Claude Code answers, and the reply is stored with usage and the model", async () => {
    const s = await chatSetup("claude_code")
    await s.send("hello")
    await s.settled()
    const r = await s.reply()
    expect(r?.status).toBe("done")
    expect(messageText(r as ChatMessage)).toBe("Echo: hello")
    expect(r?.model).toBe("sonnet")
    const call = fake.claudeCalls().at(-1) as { args: string[]; cwd: string; prompt: string }
    expect(call.args[call.args.indexOf("--append-system-prompt") + 1]).toContain("Be brief.")
    expect(realpathSync(call.cwd)).toBe(realpathSync(s.agent.workspace))
    const [task] = await s.run(Tasks.use((x) => x.list(s.local.id)))
    expect(task?.state).toBe("done")
  })

  test("Codex answers too", async () => {
    const s = await chatSetup("codex")
    await s.send("hi codex")
    await s.settled()
    expect(messageText((await s.reply()) as ChatMessage)).toBe("Echo: hi codex")
  })

  test("the earlier messages go along as a transcript", async () => {
    const s = await chatSetup("claude_code")
    await s.send("first")
    await s.settled()
    await s.send("second")
    await until(
      async () =>
        (await s.history()).messages.filter((m) => m.author === "agent" && m.status === "done")
          .length === 2,
    )
    const prompt = (fake.claudeCalls().at(-1) as { prompt: string }).prompt
    expect(prompt).toContain("User: first")
    expect(prompt).toContain("You: Echo: first")
    expect(prompt.endsWith("User: second")).toBe(true)
  })

  test("the blocks of a turn begin with the blocks of the turn before, so the model can read them from its cache", async () => {
    const s = await chatSetup("claude_code")
    await s.send("first")
    await s.settled()
    await s.send("second")
    await until(
      async () =>
        (await s.history()).messages.filter((m) => m.author === "agent" && m.status === "done")
          .length === 2,
    )
    await s.send("third")
    await until(
      async () =>
        (await s.history()).messages.filter((m) => m.author === "agent" && m.status === "done")
          .length === 3,
    )
    const [one, two, three] = fake.claudeCalls().slice(-3) as { blocks: string[] }[]
    expect(one?.blocks.slice(1)).toEqual(["User: first"])
    expect(two?.blocks.slice(0, one?.blocks.length)).toEqual(one?.blocks)
    expect(three?.blocks.slice(0, two?.blocks.length)).toEqual(two?.blocks)
    expect(three?.blocks.slice(1)).toEqual([
      "User: first",
      "You: Echo: first",
      "User: second",
      "You: Echo: second",
      "User: third",
    ])
  })

  test("for Claude Code, the memory goes with the message and stays the same in the next turns", async () => {
    const s = await chatSetup("claude_code")
    await s.run(Memory.use((m) => m.add(s.agent.id, "Likes tea.", "user")))
    await s.send("first")
    await s.settled()
    await s.run(Memory.use((m) => m.add(s.agent.id, "Has a cat.", "user")))
    await s.send("second")
    await until(
      async () =>
        (await s.history()).messages.filter((m) => m.author === "agent" && m.status === "done")
          .length === 2,
    )
    const [one, two] = fake.claudeCalls().slice(-2) as { args: string[]; blocks: string[] }[]
    const system = (call?: { args: string[] }) =>
      call?.args[(call?.args.indexOf("--append-system-prompt") ?? -2) + 1] ?? ""
    // The instructions come first in the request. They do not change from turn to turn.
    expect(system(one)).toContain("Be brief.")
    expect(system(one)).not.toContain("Likes tea.")
    expect(system(two)).toBe(system(one))
    // The notes are in the block of the message, and the message keeps them in the next turn.
    expect(one?.blocks.at(-1)).toContain("What you remember:\n- Likes tea.")
    expect(two?.blocks.slice(0, one?.blocks.length)).toEqual(one?.blocks)
    expect(two?.blocks.at(-1)).toContain("- Has a cat.")
    expect(two?.blocks.at(-1)).toContain("- Likes tea.")
    // The page of the chat shows the text of the user only.
    const shown = (await s.history()).messages.filter((m) => m.author === "user")
    expect(shown.map((m) => messageText(m))).toEqual(["first", "second"])
    const db = await s.run(Database.use((d) => Effect.succeed(d)))
    expect(
      db
        .all<{ context: string | null }>(
          "SELECT context FROM message WHERE author = 'user' ORDER BY created_at, rowid",
        )
        .map((r) => r.context?.includes("Has a cat.")),
    ).toEqual([false, true])
  })

  test("a turn with no memory keeps no notes", async () => {
    const s = await chatSetup("claude_code")
    await s.send("plain")
    await s.settled()
    const call = fake.claudeCalls().at(-1) as { blocks: string[] }
    expect(call.blocks.slice(1)).toEqual(["User: plain"])
    const db = await s.run(Database.use((d) => Effect.succeed(d)))
    expect(db.get<{ context: string | null }>("SELECT context FROM message")?.context).toBeNull()
  })

  test("Codex still gets the memory in its instructions, and keeps no notes", async () => {
    const s = await chatSetup("codex")
    await s.run(Memory.use((m) => m.add(s.agent.id, "Likes tea.", "user")))
    await s.send("hi")
    await s.settled()
    const call = fake.codexCalls().at(-1) as { prompt: string }
    expect(call.prompt).toContain("What you remember:\n- Likes tea.")
    const db = await s.run(Database.use((d) => Effect.succeed(d)))
    expect(db.get<{ context: string | null }>("SELECT context FROM message")?.context).toBeNull()
  })

  test("the usage limits of the plan are kept", async () => {
    const s = await chatSetup("claude_code")
    await s.send("hello")
    await s.settled()
    const status = await s.run(Runtimes.use((r) => Effect.sync(() => r.cached("claude_code"))))
    expect(status.limits.map((l) => l.window)).toEqual(["five_hour", "seven_day"])
  })

  test("a usage limit fails the reply with the time it resets", async () => {
    const s = await chatSetup("claude_code")
    await s.send("LIMIT")
    await s.settled()
    const r = await s.reply()
    expect(r?.status).toBe("failed")
    expect(r?.error).toMatchObject({ code: "provider_limit", resetsAt: 1_900_000_000_000 })
  })

  test("Stop ends a turn that is running", async () => {
    const s = await chatSetup("claude_code")
    await s.send("SLOW")
    await until(
      async () =>
        messageText(((await s.reply()) ?? { parts: [] }) as ChatMessage) === "Thinking slowly",
    )
    const started = Date.now()
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await s.settled()
    expect((await s.reply())?.status).toBe("stopped")
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe("knowledge on a subscription", () => {
  test("the program gets the contents list and the folder; files it writes are read again after the turn", async () => {
    const s = await chatSetup("claude_code")
    await s.run(
      Knowledge.use((k) =>
        k.save(s.agent.id, { file: null, title: "Alpha", summary: "first note", body: "x" }),
      ),
    )
    await s.send("SLOW")
    await until(
      async () =>
        messageText(((await s.reply()) ?? { parts: [] }) as ChatMessage) === "Thinking slowly",
    )
    const call = fake.claudeCalls().at(-1) as { args: string[] }
    const instructions = call.args[call.args.indexOf("--append-system-prompt") + 1] ?? ""
    expect(instructions).toContain("- Alpha: first note")
    expect(instructions).toContain(join(s.agent.workspace, "Knowledge"))
    expect(instructions).toContain("title:")
    expect(instructions).not.toContain("write_article")
    // The program writes a file with its own tools while the turn runs.
    const folder = join(s.agent.workspace, "Knowledge")
    mkdirSync(folder, { recursive: true })
    writeFileSync(
      join(folder, "Written.md"),
      "---\ntitle: Written\nsummary: By the program\n---\n\nText.\n",
    )
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await s.settled()
    const view = await s.run(Knowledge.use((k) => k.list(s.agent.id)))
    expect(view.articles.map((a) => [a.title, a.editor])).toEqual([
      ["Alpha", "user"],
      ["Written", "agent"],
    ])
    // The contents list of the next turn has the new article.
    const seen = fake.claudeCalls().length
    await s.send("hello")
    await until(() => fake.claudeCalls().length > seen)
    const next = fake.claudeCalls().at(-1) as { args: string[] }
    expect(next.args[next.args.indexOf("--append-system-prompt") + 1]).toContain(
      "- Written: By the program",
    )
  })
})

describe("approvals for a subscription", () => {
  test("at Ask for everything, a step waits on a card; Allow lets it run", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    await s.send("RUN: touch a.txt")
    await until(async () => (await s.card())?.state === "waiting")
    expect((await s.card())?.ask).toEqual({
      kind: "approval",
      summary: "touch a.txt",
      askedAt: expect.any(Number),
    })
    await s.respond("allow")
    await s.settled()
    const r = await s.reply()
    expect(messageText(r as ChatMessage)).toBe("It ran.")
    expect((await s.card())?.state).toBe("done")
  })

  test("Deny reaches the program, and the card shows the step as failed", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    await s.send("RUN: touch a.txt")
    await until(async () => (await s.card())?.state === "waiting")
    await s.respond("deny")
    await s.settled()
    expect(messageText((await s.reply()) as ChatMessage)).toBe("It was denied.")
    expect((await s.card())?.state).toBe("failed")
  })

  test("at Ask for risky steps, an ordinary command runs without a card", async () => {
    const s = await chatSetup("claude_code", "ask_risky")
    await s.send("RUN: touch a.txt")
    await s.settled()
    expect(messageText((await s.reply()) as ChatMessage)).toBe("It ran.")
  })

  test("at Ask for risky steps, sudo waits for the user", async () => {
    const s = await chatSetup("claude_code", "ask_risky")
    await s.send("RUN: sudo ls")
    await until(async () => (await s.card())?.state === "waiting")
    await s.respond("deny")
    await s.settled()
    expect(messageText((await s.reply()) as ChatMessage)).toBe("It was denied.")
  })

  test("at Full access nothing waits", async () => {
    const s = await chatSetup("claude_code", "full")
    await s.send("RUN: sudo ls")
    await s.settled()
    expect(messageText((await s.reply()) as ChatMessage)).toBe("It ran.")
  })

  test("Always allow is remembered for the next step of the same kind", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    await s.send("RUN: touch a.txt")
    await until(async () => (await s.card())?.state === "waiting")
    await s.respond("always")
    await s.settled()
    await s.send("RUN: touch b.txt")
    await until(
      async () =>
        (await s.history()).messages.filter((m) => m.author === "agent" && m.status === "done")
          .length === 2,
    )
    expect(messageText((await s.reply()) as ChatMessage)).toBe("It ran.")
  })

  test("Codex gets a sandbox from the permission level, since it cannot ask", async () => {
    const s = await chatSetup("codex", "ask_all")
    await s.send("hello")
    await s.settled()
    const call = fake.codexCalls().at(-1) as { args: string[] }
    expect(call.args[call.args.indexOf("-s") + 1]).toBe("read-only")
  })
})

describe("approvals of Muse Code answered from other devices", () => {
  test("a linked device and the sync peer answer the card; their Always allow is one Allow and saves no rule", async () => {
    const s = await chatSetup("muse")
    const done = () =>
      s
        .history()
        .then((h) => h.messages.filter((m) => m.author === "agent" && m.status === "done").length)
    /** The answer of a linked device: the sync peer is a linked device too (spec 012, 019). */
    const answer = (name: string, value: string) =>
      runRequest(
        s.t.runtime,
        "tools.respond",
        { agentId: s.agent.id, callId: "tool-1", answer: value },
        { id: `device-${name}`, name },
      )

    await s.send("do it [ask]")
    await until(async () => (await s.card())?.state === "waiting")
    expect((await s.card())?.ask).toMatchObject({
      kind: "approval",
      summary: "rm /etc/robot-test",
    })
    // The island and the system notice show the same request.
    const waiting = await s.run(Notifier.use((n) => Effect.succeed(n.island().waiting)))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ callId: "tool-1", kind: "approval", always: true })

    // A linked device says "Always allow": the step runs once, and the card names the device.
    expect((await answer("Phone", "always")).ok).toBe(true)
    await s.settled()
    expect(messageText((await s.reply()) as ChatMessage)).toBe("Ran it.")
    expect((await s.card())?.decision).toEqual({ answer: "allow", by: "Phone" })

    // No rule was saved, so the same step asks again. The sync peer denies it.
    await s.send("do it again [ask]")
    await until(async () => (await s.card())?.state === "waiting")
    expect((await answer("MacBook 2", "deny")).ok).toBe(true)
    await s.settled()
    expect(messageText((await s.reply()) as ChatMessage)).toBe("Not allowed.")
    expect((await s.card())?.decision).toEqual({ answer: "deny", by: "MacBook 2" })

    // The window of this computer can make the rule, and then the step asks nothing.
    await s.send("third [ask]")
    await until(async () => (await s.card())?.state === "waiting")
    await s.run(Tools.use((x) => x.respond(s.agent.id, "tool-1", "always")))
    await until(async () => (await done()) === 3)
    await s.send("fourth [ask]")
    await until(async () => (await done()) === 4)
    expect(messageText((await s.reply()) as ChatMessage)).toBe("Ran it.")
    expect((await s.card())?.decision).toBeUndefined()
  })
})

describe("the browser for a subscription", () => {
  const toolParts = async (s: Awaited<ReturnType<typeof chatSetup>>) =>
    ((await s.reply())?.parts ?? []).filter((p) => p.kind === "tool")
  const open = 'BROWSER:browser_open {"url":"https://example.com/a"}'

  test("Claude Code opens a page in the browser window of the agent; one card, named as for an API agent", async () => {
    const s = await chatSetup("claude_code", "full")
    await s.send(open)
    await s.settled()
    expect(s.t.browserLog).toContain(`${s.agent.id}:open https://example.com/a`)
    expect(messageText((await s.reply()) as ChatMessage)).toContain(
      "Page: Opened https://example.com/a",
    )
    // The program reports its own call too. The reply shows the card of the app only.
    const parts = await toolParts(s)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ id: "app-1", name: "browser_open", state: "done" })
    // The user holds the same window as for an API agent.
    expect(await s.run(Tools.use((x) => Effect.succeed(x.browserState(s.agent.id))))).toEqual({
      open: true,
      control: false,
    })
  })

  test("at Ask for everything the app shows its card, and Allow opens the page", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")
    expect((await s.card())?.id).toBe("app-1")
    expect(s.t.browserLog).toEqual([])
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-1", "allow")))
    await s.settled()
    expect(s.t.browserLog).toContain(`${s.agent.id}:open https://example.com/a`)
    expect((await toolParts(s)).map((p) => p.state)).toEqual(["done"])
  })

  test("Deny keeps the window closed, and the program is told", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-1", "deny")))
    await s.settled()
    expect(s.t.browserLog).toEqual([])
    expect(messageText((await s.reply()) as ChatMessage)).toContain("The user denied this step.")
    expect((await toolParts(s)).map((p) => p.state)).toEqual(["failed"])
  })

  test("Stop while the card waits ends the turn", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")
    await s.run(Chat.use((c) => c.stop(s.agent.id)))
    await s.settled()
    expect((await s.reply())?.status).toBe("stopped")
    expect(s.t.browserLog).toEqual([])
  })
})

describe("the browser step of a subscription agent, seen and answered from other devices", () => {
  const open = 'BROWSER:browser_open {"url":"https://example.com/a"}'
  const opened = (s: Awaited<ReturnType<typeof chatSetup>>) =>
    s.t.browserLog.filter((x) => x === `${s.agent.id}:open https://example.com/a`).length

  /** What the other computer does with a message: every field is read again and checked strictly. */
  const syncAccepts = async (s: Awaited<ReturnType<typeof chatSetup>>) => {
    const db = await s.run(Database.use((d) => Effect.succeed(d)))
    const id = ((await s.reply()) as ChatMessage).id
    const read = KINDS.message.read({ db, self: "dev-a" } as Ctx, id)
    if (!read) return false
    const stamp = [Date.now(), 0, "dev-a"]
    const fields = JSON.parse(JSON.stringify(read.fields)) as Record<string, unknown>
    return (
      parseOp(
        {
          k: "message",
          i: id,
          o: "dev-a",
          f: Object.fromEntries(Object.entries(fields).map(([n, v]) => [n, { v, s: stamp }])),
        },
        Date.now(),
      ) !== undefined
    )
  }

  test("a linked device and the sync peer answer the card; their Always allow is one Allow and saves no rule, also on this computer; the card passes the sync check", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    /** The answer of a linked device: the sync peer is a linked device too (spec 012, 019). */
    const answer = (name: string, value: string) =>
      runRequest(
        s.t.runtime,
        "tools.respond",
        { agentId: s.agent.id, callId: "app-1", answer: value },
        { id: `device-${name}`, name },
      )
    const done = () =>
      s
        .history()
        .then((h) => h.messages.filter((m) => m.author === "agent" && m.status === "done").length)

    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")
    expect((await s.card())?.ask).toMatchObject({
      kind: "approval",
      summary: "https://example.com/a",
    })
    // The card that waits, with its ask, is a card that the other computer takes.
    expect(await syncAccepts(s)).toBe(true)
    // The island and the system notice show the request. A step of the browser has no rules, so
    // there is no choice to always allow (spec 007, "Permission rules").
    const waiting = await s.run(Notifier.use((n) => Effect.succeed(n.island().waiting)))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({
      callId: "app-1",
      kind: "approval",
      step: "browser",
      always: false,
    })

    // A linked device says "Always allow": the page opens once, and the card names the device.
    expect((await answer("Phone", "always")).ok).toBe(true)
    await s.settled()
    expect(opened(s)).toBe(1)
    expect((await s.card())?.decision).toEqual({ answer: "allow", by: "Phone" })
    expect(await syncAccepts(s)).toBe(true)

    // No rule was saved, so the same step asks again. The sync peer denies it.
    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")
    expect((await answer("MacBook 2", "deny")).ok).toBe(true)
    await s.settled()
    expect(opened(s)).toBe(1)
    expect(messageText((await s.reply()) as ChatMessage)).toContain("The user denied this step.")
    expect((await s.card())?.decision).toEqual({ answer: "deny", by: "MacBook 2" })
    expect(await syncAccepts(s)).toBe(true)

    // The sync peer says "Always allow" too: one Allow, and the step asks again afterwards.
    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")
    expect((await answer("MacBook 2", "always")).ok).toBe(true)
    await s.settled()
    expect(opened(s)).toBe(2)
    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")

    // The window of this computer has no rule to make for a step of the browser: its "always" is
    // one Allow too, and the step asks again afterwards.
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-1", "always")))
    await until(async () => (await done()) === 4)
    expect(opened(s)).toBe(3)
    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-1", "deny")))
    await until(async () => (await done()) === 5)
    expect(opened(s)).toBe(3)
    expect(await syncAccepts(s)).toBe(true)
  })
})

describe("the browser for a subscription: the status island", () => {
  const open = 'BROWSER:browser_open {"url":"https://example.com/a"}'
  type Setup = Awaited<ReturnType<typeof chatSetup>>
  const island = (s: Setup) => s.run(Notifier.use((n) => Effect.succeed(n.island())))
  /** The kind of step of the agent at each change, from now on. */
  const watchSteps = async (s: Setup) => {
    const steps: (ToolStepKind | null)[] = []
    await s.run(
      Activity.use((a) => Effect.sync(() => a.onChange(() => steps.push(a.stepOf(s.agent.id))))),
    )
    return steps
  }

  // The program reports its call as "mcp__robot__browser_open", and the app drops that report
  // (see the filter in Chat and Channels). The kind of step comes from the card of the app.
  // From the name of the program it would be "a connection".
  test("a step of the browser says the browser, also while the user is asked", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    const steps = await watchSteps(s)
    await s.send(open)
    await until(async () => (await s.card())?.state === "waiting")
    const state = await island(s)
    expect(state.waiting).toHaveLength(1)
    expect(state.waiting[0]).toMatchObject({
      kind: "approval",
      agentId: s.agent.id,
      callId: "app-1",
      step: "browser",
      place: null,
    })
    expect(state.rows[0]?.doing).toEqual({ kind: "tool", tool: "browser" })
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-1", "allow")))
    await s.settled()
    expect(steps).toContain("browser")
    expect(steps).not.toContain("connection")
    // Nothing is left on the island when the turn ends.
    await until(async () => (await island(s)).count === 0)
    const after = await island(s)
    expect(after.waiting).toEqual([])
    expect(after.rows).toEqual([])
  })

  test("at Full access the step of the browser shows as the browser, and ends with the call", async () => {
    const s = await chatSetup("claude_code", "full")
    const steps = await watchSteps(s)
    await s.send(open)
    await s.settled()
    await until(async () => (await island(s)).count === 0)
    // The agent starts with no step, then the browser, then none again.
    expect(steps.filter((x, i) => x !== steps[i - 1])).toEqual([null, "browser", null])
  })

  test("in a channel the request names the channel and the browser", async () => {
    const s = await chatSetup("claude_code", "ask_all")
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Ops",
          topic: "",
          memberIds: [s.agent.id],
          leadId: null,
        }),
      ),
    )
    const steps = await watchSteps(s)
    await s.run(Channels.use((c) => c.send(channel.id, `@Ada ${open}`)))
    await until(async () => (await island(s)).waiting.length === 1)
    const state = await island(s)
    expect(state.waiting[0]).toMatchObject({
      kind: "approval",
      callId: "app-1",
      step: "browser",
      place: "Ops",
    })
    expect(state.rows[0]?.doing).toEqual({ kind: "tool", tool: "browser" })
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-1", "allow")))
    await until(async () => (await island(s)).count === 0)
    expect((await island(s)).waiting).toEqual([])
    expect(steps).toContain("browser")
    expect(steps).not.toContain("connection")
  })
})

describe("runtime states (spec 006)", () => {
  /** A program of its own that runs the stand-in, so a test can remove it, or make it fail. */
  const wrapped = (flag?: string) => {
    const dir = tempDir("robot-wrap-")
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

  test("a turn that cannot start the program sets Needs repair at once; the next turn fails at once, in words", async () => {
    fake.setCodex(signedIn)
    const flag = join(tempDir("robot-flag-"), "broken")
    const program = wrapped(flag)
    await using(program.path, async () => {
      const s = await chatSetup("codex")
      // The program works for the check and breaks after it.
      expect(await s.run(Runtimes.use((r) => Effect.sync(() => r.cached("codex"))))).toMatchObject({
        state: "ready",
      })
      writeFileSync(flag, "x")
      await s.send("hello")
      await s.settled()
      const reply = await s.reply()
      expect(reply?.status).toBe("failed")
      expect(reply?.error).toMatchObject({ code: "runtime_repair_start" })
      expect(await s.run(Runtimes.use((r) => Effect.sync(() => r.cached("codex"))))).toMatchObject({
        state: "needs_repair",
        reason: "start",
      })
      // The agent shows the problem, so the message box can be off.
      const agent = await s.run(Agents.use((a) => a.get(s.agent.id)))
      expect(agent.runtimeProblem).toMatchObject({ state: "needs_repair", reason: "start" })
      // The next turn fails at once, with the state in words, and does not start the program.
      const asked = fake.asks("codex").length
      const next = await s.run(
        Chat.use((c) => c.send({ agentId: s.agent.id, text: "again", replyTo: null })).pipe(
          Effect.exit,
        ),
      )
      expect(code(next as Exit.Exit<unknown, { code: string }>)).toBe("runtime_repair_start")
      expect(fake.asks("codex")).toHaveLength(asked)
    })
  })

  test("a program that was never found fails a turn at once, with the state in words", async () => {
    fake.setCodex(signedIn)
    const s = await chatSetup("codex")
    // The app never saw the program at the place that is set now.
    rmSync(join(s.t.dataDir, "runtimes", "places.json"), { force: true })
    await using("/no/such/codex", async () => {
      await s.run(Runtimes.use((r) => r.status("codex")))
      const next = await s.run(
        Chat.use((c) => c.send({ agentId: s.agent.id, text: "hello", replyTo: null })).pipe(
          Effect.exit,
        ),
      )
      expect(code(next as Exit.Exit<unknown, { code: string }>)).toBe("runtime_missing")
      const agent = await s.run(Agents.use((a) => a.get(s.agent.id)))
      expect(agent.runtimeProblem).toMatchObject({ state: "not_installed" })
    })
  })

  test("a task from a routine, a channel or a workflow fails at once, with the state in words", async () => {
    fake.setCodex(signedIn)
    const s = await chatSetup("codex")
    await using("/no/such/codex", async () => {
      // The program was there before, so the state is Needs repair.
      await s.run(Runtimes.use((r) => r.status("codex")))
      const exit = await s.run(
        Chat.use((c) =>
          c.send(
            { agentId: s.agent.id, text: "from a routine", replyTo: null },
            { source: "routine", sourceId: "r1" },
          ),
        ).pipe(Effect.exit),
      )
      expect(code(exit as Exit.Exit<unknown, { code: string }>)).toBe("runtime_repair_gone")
    })
  })
})

describe("the level Read only on a vendor program (spec 007)", () => {
  test("a program with no read-only mode refuses the level for an agent; one with a mode takes it", async () => {
    fake.setClaude({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "a@b.c",
      plan: "max",
      noReadOnly: true,
    })
    fake.setCodex({ loggedIn: true, method: "chatgpt" })
    const t = testRuntime()
    const run = t.runtime.runPromise
    const local = await run(Servers.use((s) => s.local))
    const claude = await run(Providers.use((p) => p.connect({ kind: "claude_code", name: "C" })))
    const codex = await run(Providers.use((p) => p.connect({ kind: "codex", name: "X" })))
    expect(await run(Providers.use((p) => p.readOnlySupported(claude.id)))).toBe(false)
    expect(await run(Providers.use((p) => p.readOnlySupported(codex.id)))).toBe(true)
    let n = 0
    const make = (accountId: string, model: string, permission?: PermissionLevel) =>
      run(
        Agents.use((a) =>
          a.create({
            serverId: local.id,
            name: `Ada ${++n}`,
            role: "",
            instructions: "",
            model: { accountId, model, effort: null },
            ...(permission ? { permission } : {}),
          }),
        ).pipe(Effect.exit),
      )
    expect(code((await make(claude.id, "sonnet", "read_only")) as never)).toBe(
      "read_only_unsupported",
    )
    expect(code((await make(claude.id, "sonnet", "ask_all")) as never)).toBe("ok")
    const ok = await make(codex.id, "default", "read_only")
    expect(code(ok as never)).toBe("ok")
    // An agent at Read only cannot move to a program that has no mode, and a level cannot be set
    // on an agent whose program has none.
    const agent = (ok as unknown as Exit.Success<{ id: string }>).value
    expect(
      code(
        (await run(
          Agents.use((a) =>
            a.update(agent.id, { model: { accountId: claude.id, model: "sonnet", effort: null } }),
          ).pipe(Effect.exit),
        )) as never,
      ),
    ).toBe("read_only_unsupported")
  })

  test("the program starts in its own read-only mode", async () => {
    const codex = await chatSetup("codex", "read_only")
    await codex.send("hello")
    await codex.settled()
    const codexArgs = (fake.codexCalls().at(-1) as { args: string[] }).args
    expect(codexArgs[codexArgs.indexOf("-s") + 1]).toBe("read-only")

    const claude = await chatSetup("claude_code", "read_only")
    await claude.send("hello")
    await claude.settled()
    const claudeArgs = (
      fake
        .claudeCalls()
        .filter((c) => "prompt" in c)
        .at(-1) as { args: string[] }
    ).args
    expect(claudeArgs[claudeArgs.lastIndexOf("--tools") + 1]).toBe(
      "Read,Grep,Glob,WebFetch,WebSearch",
    )

    const muse = await chatSetup("muse", "read_only")
    await muse.send("hello")
    await muse.settled()
    const museArgs = JSON.stringify(fake.museCalls().at(-1))
    expect(museArgs).toContain("--disable-write")
    expect(museArgs).toContain("--disable-shell")
  })

  test("a step that the program asks about is refused by the level, before any card or rule", async () => {
    const s = await chatSetup("claude_code", "read_only")
    await s.send("RUN: touch a.txt")
    await s.settled()
    // No card waited: the app refused the step, and the program was told.
    expect((await s.card())?.state).toBe("failed")
    expect(await s.card()).toMatchObject({ refused: "read_only" })
    expect(messageText((await s.reply()) as ChatMessage)).toBe("It was denied.")
    // The refused step is in the action log: Refused, decided by the level (spec 007).
    const refused = await s.run(ActionLog.use((l) => l.list({ result: "refused" })))
    expect(refused.map((e) => [e.kind, e.target, e.decidedBy])).toEqual([
      ["shell", "touch a.txt", "level"],
    ])
  })

  test("the browser of the app is refused at Read only for a vendor program too", async () => {
    const s = await chatSetup("claude_code", "read_only")
    await s.send('BROWSER:browser_open {"url":"https://example.com/a"}')
    await s.settled()
    expect(s.t.browserLog).toEqual([])
    expect((await s.card())?.state).toBe("failed")
    expect(await s.card()).toMatchObject({ refused: "read_only" })
  })
})
