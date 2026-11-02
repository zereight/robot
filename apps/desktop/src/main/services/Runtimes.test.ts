import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type ChatMessage, messageText, type PermissionLevel } from "@robot/shared"
import { Effect, Exit } from "effect"
import { type FakeRuntimes, makeFakeRuntimes, sha256, tarGzOf } from "../../../e2e/fake-runtimes.ts"
import { runRequest } from "../rpc.ts"
import { type Ctx, KINDS } from "../sync/kinds.ts"
import { parseOp } from "../sync/wire.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { Knowledge } from "./Knowledge.ts"
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
    expect(prompt.endsWith("second")).toBe(true)
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
    const waiting = await s.run(Notifier.use((n) => Effect.succeed(n.island().attention)))
    expect(waiting).toMatchObject({ callId: "tool-1", kind: "approval", always: true })

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

  test("a linked device and the sync peer answer the card; their Always allow is one Allow and saves no rule; the card passes the sync check", async () => {
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
    // The island and the system notice show the request, with the choice to always allow.
    const waiting = await s.run(Notifier.use((n) => Effect.succeed(n.island().attention)))
    expect(waiting).toMatchObject({ callId: "app-1", kind: "approval", always: true })

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

    // The window of this computer can make the rule, and then the step asks nothing.
    await s.run(Tools.use((x) => x.respond(s.agent.id, "app-1", "always")))
    await until(async () => (await done()) === 4)
    expect(opened(s)).toBe(3)
    await s.send(open)
    await until(async () => (await done()) === 5)
    expect(opened(s)).toBe(4)
    expect((await s.card())?.decision).toBeUndefined()
    expect(await syncAccepts(s)).toBe(true)
  })
})
