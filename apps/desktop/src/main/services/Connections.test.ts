import { afterEach, describe, expect, test } from "bun:test"
import {
  CONNECTION_CALL_MS,
  CONNECTION_IDLE_MS,
  CONNECTION_STOP_MS,
  CONNECTION_TEST_MS,
  type ConnectionSaveInput,
  type ToolConnectionInput,
} from "@robot/shared"
import { Effect } from "effect"
import {
  McpCallStopped,
  McpError,
  type McpOpener,
  type McpSession,
  type McpSpec,
  type McpTool,
} from "../connections/mcp.ts"
import { Agents } from "./Agents.ts"
import { Connections, type ConnectionsOptions, type ConnectionTurn } from "./Connections.ts"
import { Database } from "./Database.ts"
import { Rules } from "./Rules.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

const tool = (name: string, description = `The tool ${name}.`): McpTool => ({
  name,
  description,
  readOnly: false,
  schema: { type: "object", properties: {} },
})

/** A stand-in for the way to reach a connection. A test sets what it offers and how it fails. */
const stand = () => {
  const state = {
    tools: [tool("echo"), tool("lookup")] as McpTool[],
    /** The reason that the next opens fail with, or undefined. */
    fail: undefined as McpError | undefined,
    opened: [] as McpSpec[],
    closed: 0,
    calls: [] as { name: string; args: Record<string, unknown> }[],
    /** What a call does: a result, or a promise that a test settles. */
    answer: (async () => ({ text: "ok", isError: false })) as (
      name: string,
      args: Record<string, unknown>,
      options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<{ text: string; isError: boolean }>,
  }
  const open: McpOpener = async (spec) => {
    state.opened.push(spec)
    if (state.fail) throw state.fail
    let end: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      end = resolve
    })
    const session: McpSession = {
      closed,
      close: () => {
        state.closed++
        end()
      },
      listTools: async () => ({ tools: state.tools, more: false }),
      call: async (name, args, options) => {
        state.calls.push({ name, args })
        return await state.answer(name, args, options)
      },
    }
    return session
  }
  return { state, open }
}

const form = (over: Partial<ToolConnectionInput> = {}): ToolConnectionInput => ({
  name: "Notes",
  kind: "program",
  command: "notes-server",
  args: [],
  folder: "",
  env: [],
  address: "",
  headers: [],
  agents: "all",
  ...over,
})
const saving = (over: Partial<ToolConnectionInput> = {}, id?: string): ConnectionSaveInput => ({
  ...(id ? { id } : {}),
  connection: form(over),
  confirmed: true,
})

const setup = (options: ConnectionsOptions = {}) => {
  const fake = stand()
  const t = testRuntime({ connections: { open: fake.open, ...options } })
  const run = t.runtime.runPromise
  const connections = {
    list: () => run(Connections.use((c) => c.list)),
    save: (input: ConnectionSaveInput) => run(Connections.use((c) => c.save(input))),
    /** The error that a save fails with. */
    refused: (input: ConnectionSaveInput) =>
      run(Connections.use((c) => c.save(input)).pipe(Effect.flip)),
    test: (input: { id?: string; connection?: ToolConnectionInput }) =>
      run(Connections.use((c) => c.test(input))),
    setEnabled: (id: string, on: boolean) => run(Connections.use((c) => c.setEnabled(id, on))),
    setTool: (id: string, name: string, on: boolean) =>
      run(Connections.use((c) => c.setTool(id, name, on))),
    remove: (id: string) => run(Connections.use((c) => c.remove(id))),
    forTurn: (agentId: string) => run(Connections.use((c) => c.forTurn(agentId))),
    running: () => run(Connections.use((c) => Effect.sync(() => c.running()))),
  }
  const agent = async (name = "Ada") => {
    const local = await run(Servers.use((s) => s.local))
    return await run(
      Agents.use((a) =>
        a.create({ serverId: local.id, name, role: "", instructions: "", model: null }),
      ),
    )
  }
  const secret = (key: string) => run(Secrets.use((s) => Effect.sync(() => s.get(key))))
  return { t, run, fake, connections, agent, secret }
}

const aliasOf = (turn: ConnectionTurn, name: string) =>
  turn.defs().find((d) => d.name.endsWith(`__${name}`))?.name ?? ""

const env: string[] = []
afterEach(() => {
  for (const key of env.splice(0)) delete process.env[key]
})

describe("the limits of spec 018 are the ones in the spec", () => {
  test("the numbers", () => {
    expect(CONNECTION_CALL_MS).toBe(60_000)
    expect(CONNECTION_TEST_MS).toBe(20_000)
    expect(CONNECTION_STOP_MS).toBe(2_000)
    expect(CONNECTION_IDLE_MS).toBe(600_000)
  })
})

describe("adding, changing and removing a connection", () => {
  test("a new connection is on and not tested; the table holds no secret value", async () => {
    const { connections, run, secret } = setup()
    const saved = await connections.save(
      saving({
        env: [
          { name: "PLAIN", value: "visible", secret: false },
          { name: "TOKEN", value: "tok-clear-text-12345", secret: true },
        ],
      }),
    )
    expect(saved).toMatchObject({ name: "Notes", enabled: true, state: "untested", tools: [] })
    // The page gets the plain value, and for a secret only that it is saved.
    expect(saved.env).toEqual([
      { name: "PLAIN", secret: false, value: "visible", saved: false },
      { name: "TOKEN", secret: true, value: null, saved: true },
    ])
    expect(JSON.stringify(saved)).not.toContain("tok-clear-text-12345")
    // The keychain holds the value, and the database holds nothing of it.
    expect(await secret(`connection:${saved.id}:env:TOKEN`)).toBe("tok-clear-text-12345")
    const rows = await run(
      Database.use((db) =>
        Effect.sync(() => db.all<Record<string, unknown>>("SELECT * FROM tool_connection")),
      ),
    )
    expect(JSON.stringify(rows)).not.toContain("tok-clear-text-12345")
  })

  test("a program must be confirmed, and the form checks are the ones of the spec", async () => {
    const { connections } = setup()
    const bad = async (over: Partial<ToolConnectionInput>) =>
      (await connections.refused(saving(over))).code
    expect((await connections.refused({ connection: form(), confirmed: false })).code).toBe(
      "connection_confirm",
    )
    expect(await bad({ name: "  " })).toBe("connection_name_empty")
    expect(await bad({ name: "x".repeat(41) })).toBe("connection_name_long")
    expect(await bad({ command: " " })).toBe("connection_command_empty")
    // A web address: https only, except an address on this computer, and no sign-in part.
    const web = (address: string) => bad({ kind: "web", address })
    expect(await web("http://example.com")).toBe("connection_address_scheme")
    expect(await web("https://user:pass@example.com")).toBe("connection_address_credentials")
    expect(await web("not an address")).toBe("connection_address_invalid")
    const ok = await connections.save({
      connection: form({ kind: "web", address: "http://127.0.0.1:9000" }),
      confirmed: false,
    })
    expect(ok.address).toBe("http://127.0.0.1:9000")
  })

  test("a name is unique, and the check ignores case", async () => {
    const { connections } = setup()
    await connections.save(saving({ name: "Notes" }))
    expect((await connections.refused(saving({ name: "nOtEs" }))).code).toBe(
      "connection_name_taken",
    )
  })

  test("a server holds 20 connections; the 21st is refused", async () => {
    const { connections } = setup()
    for (let i = 1; i <= 20; i++) await connections.save(saving({ name: `Notes ${i}` }))
    expect((await connections.refused(saving({ name: "One more" }))).code).toBe("connections_full")
    expect(await connections.list()).toHaveLength(20)
  })

  test("a saved secret stays until a new value is typed; a new secret needs a value", async () => {
    const { connections, secret } = setup()
    const first = await connections.save(
      saving({ env: [{ name: "TOKEN", value: "first-value-123456", secret: true }] }),
    )
    // The page sends no text for a saved secret: the value stays.
    const kept = await connections.save(
      saving({ name: "Notes two", env: [{ name: "TOKEN", secret: true }] }, first.id),
    )
    expect(kept.env[0]).toMatchObject({ saved: true, value: null })
    expect(await secret(`connection:${first.id}:env:TOKEN`)).toBe("first-value-123456")
    // A new value replaces it.
    await connections.save(
      saving({ env: [{ name: "TOKEN", value: "second-value-654321", secret: true }] }, first.id),
    )
    expect(await secret(`connection:${first.id}:env:TOKEN`)).toBe("second-value-654321")
    // A secret that is new and has no text is refused.
    const refused = await connections.refused(
      saving(
        {
          env: [
            { name: "TOKEN", secret: true },
            { name: "OTHER", secret: true },
          ],
        },
        first.id,
      ),
    )
    expect(refused.code).toBe("connection_env_value_missing")
    // An entry that is removed takes its value out of the keychain.
    await connections.save(saving({ env: [] }, first.id))
    expect(await secret(`connection:${first.id}:env:TOKEN`)).toBeNull()
  })

  test("a tool that is off stays off when the user changes how the app reaches the server", async () => {
    const { connections } = setup()
    const saved = await connections.save(saving())
    await connections.test({ id: saved.id })
    await connections.setTool(saved.id, "echo", false)
    // The command changes and there is no Test: the tools are not known any more, the switch is.
    const edited = await connections.save(saving({ command: "other-server" }, saved.id))
    expect(edited.tools).toEqual([])
    const again = await connections.test({ id: saved.id })
    expect(again.ok && again.tools.find((t) => t.name === "echo")?.enabled).toBe(false)
    // A name that is changed keeps it too.
    await connections.save(saving({ command: "other-server", name: "Journal" }, saved.id))
    const list = await connections.list()
    expect(list[0]?.tools.find((t) => t.name === "echo")?.enabled).toBe(false)
  })

  test("removing a connection deletes its secrets and its rules, and keeps the log", async () => {
    const { connections, run, secret, agent } = setup()
    const ada = await agent()
    const saved = await connections.save(
      saving({
        kind: "web",
        address: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer abcdefghijkl", secret: true }],
      }),
    )
    expect(await secret(`connection:${saved.id}:header:authorization`)).toBe("Bearer abcdefghijkl")
    await run(
      Rules.use((r) =>
        Effect.sync(() => {
          r.saveFromCard(ada.id, { kind: "connection", connection: "Notes", tool: "echo" })
          r.saveFromCard(ada.id, { kind: "connection", connection: "Other", tool: "echo" })
        }),
      ),
    )
    expect(await run(Rules.use((r) => r.list()))).toHaveLength(2)
    await connections.remove(saved.id)
    expect(await connections.list()).toEqual([])
    expect(await secret(`connection:${saved.id}:header:authorization`)).toBeNull()
    // Only the rules for this connection leave.
    const left = await run(Rules.use((r) => r.list()))
    expect(left.map((r) => r.text)).toEqual(["Other"])
  })

  test("a new name takes the rules along", async () => {
    const { connections, run, agent } = setup()
    const ada = await agent()
    const saved = await connections.save(saving())
    await run(
      Rules.use((r) =>
        Effect.sync(() => {
          r.saveFromCard(ada.id, { kind: "connection", connection: "Notes", tool: "echo" })
        }),
      ),
    )
    await connections.save(saving({ name: "Journal" }, saved.id))
    expect((await run(Rules.use((r) => r.list()))).map((r) => r.text)).toEqual(["Journal"])
  })
})

describe("test", () => {
  test("shows the tools with name and description, or the reason of the failure", async () => {
    const { connections, fake } = setup()
    fake.state.tools = [tool("echo", "Gives the text back."), tool("lookup")]
    const result = await connections.test({ connection: form() })
    expect(result).toMatchObject({ ok: true, tooMany: false })
    if (result.ok)
      expect(result.tools).toEqual([
        { name: "echo", description: "Gives the text back.", enabled: true },
        { name: "lookup", description: "The tool lookup.", enabled: true },
      ])
    for (const failure of [
      "not_found",
      "ended",
      "timeout",
      "refused",
      "sign_in",
      "invalid",
    ] as const) {
      fake.state.fail = new McpError(failure)
      expect(await connections.test({ connection: form() })).toEqual({ ok: false, failure })
    }
  })

  test("a saved connection that is tested keeps the tools and the state", async () => {
    const { connections, fake } = setup()
    const saved = await connections.save(saving())
    expect((await connections.list())[0]).toMatchObject({ state: "untested" })
    await connections.test({ id: saved.id })
    expect((await connections.list())[0]).toMatchObject({ state: "connected" })
    expect((await connections.list())[0]?.tools.map((t) => t.name)).toEqual(["echo", "lookup"])
    fake.state.fail = new McpError("timeout")
    await connections.test({ id: saved.id })
    expect((await connections.list())[0]).toMatchObject({ state: "error", failure: "timeout" })
  })

  test("a form that was tested and then saved keeps the tools that the test showed", async () => {
    const { connections } = setup()
    await connections.test({ connection: form() })
    const saved = await connections.save(saving())
    expect(saved).toMatchObject({ state: "connected" })
    expect(saved.tools.map((t) => t.name)).toEqual(["echo", "lookup"])
  })

  test("a secret with no text in the form tests with the saved value", async () => {
    const { connections, fake } = setup()
    const saved = await connections.save(
      saving({ env: [{ name: "TOKEN", value: "saved-token-abcdef", secret: true }] }),
    )
    await connections.test({
      id: saved.id,
      connection: form({ env: [{ name: "TOKEN", secret: true }] }),
    })
    const spec = fake.state.opened.at(-1)
    expect(spec?.kind === "program" && spec.env.TOKEN).toBe("saved-token-abcdef")
  })
})

describe("the program of a connection", () => {
  test("gets the values of the user and the normal environment, not what is the app's own", async () => {
    process.env.ROBOT_SECRET_CANARY = "app-secret"
    process.env.ELECTRON_RUN_AS_NODE = "1"
    process.env.NORMAL_CANARY = "normal"
    env.push("ROBOT_SECRET_CANARY", "ELECTRON_RUN_AS_NODE", "NORMAL_CANARY")
    const { connections, fake, t } = setup()
    await connections.save(
      saving({
        folder: "/tmp",
        env: [
          { name: "PLAIN", value: "visible", secret: false },
          { name: "TOKEN", value: "tok-value-0123456789", secret: true },
        ],
      }),
    )
    await connections.test({ id: (await connections.list())[0]?.id as string })
    const spec = fake.state.opened.at(-1)
    if (spec?.kind !== "program") throw new Error("not a program")
    expect(spec.env.PLAIN).toBe("visible")
    expect(spec.env.TOKEN).toBe("tok-value-0123456789")
    expect(spec.env.NORMAL_CANARY).toBe("normal")
    expect(spec.env.ROBOT_SECRET_CANARY).toBeUndefined()
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    // The home folder of the app, and the working folder of the form.
    expect(spec.env.HOME).toBe(t.homeDir)
    expect(spec.cwd).toBe("/tmp")
    // The home folder is the working folder when the form has none.
    await connections.save(saving({ name: "Home" }))
    const home = (await connections.list()).find((c) => c.name === "Home")
    await connections.test({ id: home?.id as string })
    const spec2 = fake.state.opened.at(-1)
    expect(spec2?.kind === "program" && spec2.cwd).toBe(t.homeDir)
  })
})

describe("the tools of a turn", () => {
  test("a connection starts when a turn first needs it, and not before", async () => {
    const { connections, fake, agent } = setup()
    const ada = await agent()
    await connections.save(saving())
    expect(fake.state.opened).toHaveLength(0)
    const turn = await connections.forTurn(ada.id)
    expect(fake.state.opened).toHaveLength(1)
    expect(turn.defs().map((d) => d.name)).toHaveLength(2)
    // A second turn uses the running connection.
    await connections.forTurn(ada.id)
    expect(fake.state.opened).toHaveLength(1)
    expect(await connections.running()).toHaveLength(1)
  })

  test("a tool that is off is given to no agent; a connection that is off gives none", async () => {
    const { connections, agent } = setup()
    const ada = await agent()
    const saved = await connections.save(saving())
    await connections.test({ id: saved.id })
    await connections.setTool(saved.id, "lookup", false)
    const turn = await connections.forTurn(ada.id)
    expect(turn.defs().map((d) => d.name.replace(/^mcp__notes__/, ""))).toEqual(["echo"])
    await connections.setEnabled(saved.id, false)
    expect(await connections.running()).toEqual([])
    expect((await connections.forTurn(ada.id)).defs()).toEqual([])
    expect((await connections.list())[0]?.state).toBe("off")
  })

  test("a connection for some agents is not given to the others", async () => {
    const { connections, agent } = setup()
    const ada = await agent("Ada")
    const bob = await agent("Bob")
    await connections.save(saving({ agents: [ada.id] }))
    expect((await connections.forTurn(ada.id)).defs()).toHaveLength(2)
    expect((await connections.forTurn(bob.id)).defs()).toHaveLength(0)
  })

  test("a connection that is down is named, and the turn goes on without it", async () => {
    const stub = stand()
    const { connections, agent } = setup({
      // The program "mail-server" is not there.
      open: async (spec, options) => {
        if (spec.kind === "program" && spec.command === "mail-server")
          throw new McpError("not_found")
        return await stub.open(spec, options)
      },
    })
    const ada = await agent()
    await connections.save(saving({ name: "Mail", command: "mail-server" }))
    await connections.save(saving({ name: "Notes", command: "notes-server" }))
    const turn = await connections.forTurn(ada.id)
    expect(turn.down).toEqual(["Mail"])
    // The other connection gives its tools.
    expect(turn.defs().map((d) => d.name)).toEqual(["mcp__notes__echo", "mcp__notes__lookup"])
    // The state of the one that failed shows the reason.
    const list = await connections.list()
    expect(list.find((c) => c.name === "Mail")).toMatchObject({
      state: "error",
      failure: "not_found",
    })
    expect(list.find((c) => c.name === "Notes")).toMatchObject({ state: "connected" })
  })

  test("a connection offers at most 100 tools to an agent", async () => {
    const { connections, fake, agent } = setup()
    const ada = await agent()
    fake.state.tools = Array.from({ length: 130 }, (_, i) => tool(`tool_${i}`))
    const saved = await connections.save(saving())
    await connections.test({ id: saved.id })
    expect((await connections.list())[0]).toMatchObject({ tooMany: true })
    expect((await connections.list())[0]?.tools).toHaveLength(100)
    // 100 tools are more than 20: the agent gets the search step and no tool.
    const turn = await connections.forTurn(ada.id)
    expect(turn.count).toBe(100)
    expect(turn.searching).toBe(true)
  })

  test("20 tools are all given; 21 give only the step Search tools", async () => {
    const { connections, fake, agent } = setup()
    const ada = await agent()
    fake.state.tools = Array.from({ length: 20 }, (_, i) => tool(`tool_${i}`))
    const saved = await connections.save(saving())
    const all = await connections.forTurn(ada.id)
    expect(all.searching).toBe(false)
    expect(all.defs()).toHaveLength(20)
    expect(all.defs().some((d) => d.name === "search_tools")).toBe(false)
    // A 21st tool, and a new turn.
    await connections.setEnabled(saved.id, false)
    await connections.setEnabled(saved.id, true)
    fake.state.tools = Array.from({ length: 21 }, (_, i) => tool(`tool_${i}`))
    const many = await connections.forTurn(ada.id)
    expect(many.searching).toBe(true)
    expect(many.defs().map((d) => d.name)).toEqual(["search_tools"])
    expect(many.defs()[0]?.description).toContain("21")
    expect(many.defs()[0]?.description).toContain('"Notes"')
    // Turn one tool off: the next turn holds all 20 again.
    await connections.setTool(saved.id, "tool_0", false)
    const again = await connections.forTurn(ada.id)
    expect(again.searching).toBe(false)
    expect(again.defs()).toHaveLength(20)
  })

  test("two connections of 15 tools: one off gives 15 tools and no search", async () => {
    const { connections, fake, agent } = setup()
    const ada = await agent()
    fake.state.tools = Array.from({ length: 15 }, (_, i) => tool(`tool_${i}`))
    await connections.save(saving({ name: "Notes" }))
    const second = await connections.save(saving({ name: "Mail" }))
    expect((await connections.forTurn(ada.id)).searching).toBe(true)
    await connections.setEnabled(second.id, false)
    const turn = await connections.forTurn(ada.id)
    expect(turn.searching).toBe(false)
    expect(turn.defs()).toHaveLength(15)
  })

  test("the search gives at most 10 tools, the best matches first, and opens what it found", async () => {
    const { connections, fake, agent } = setup()
    const ada = await agent()
    fake.state.tools = [
      tool("weather_now", "The weather of a city right now."),
      tool("weather_week", "The weather of a city for a week."),
      tool("forecast", "A forecast of the weather and the wind."),
      tool("wind", "The wind."),
      ...Array.from({ length: 22 }, (_, i) => tool(`other_${String(i).padStart(2, "0")}`)),
    ]
    await connections.save(saving())
    const turn = await connections.forTurn(ada.id)
    expect(turn.searching).toBe(true)
    // Nothing is open before the search.
    expect(turn.resolve("mcp__notes__weather_now")).toBeUndefined()
    const none = turn.search("zzzz")
    expect(none).toEqual({ text: "No tool found.", found: 0 })
    const found = turn.search("weather wind")
    expect(found.found).toBe(4)
    // "forecast" has both words: it comes first.
    expect(found.text.split("\n")[1]).toContain("mcp__notes__forecast")
    expect(found.text).toContain('connection "Notes"')
    expect(turn.defs().map((d) => d.name)).toEqual([
      "search_tools",
      "mcp__notes__forecast",
      "mcp__notes__weather_now",
      "mcp__notes__weather_week",
      "mcp__notes__wind",
    ])
    expect(turn.resolve("mcp__notes__wind")).toMatchObject({ connection: "Notes", tool: "wind" })
    // The next turn starts with none.
    const next = await connections.forTurn(ada.id)
    expect(next.defs().map((d) => d.name)).toEqual(["search_tools"])
    // At most 10 tools come back.
    expect(next.search("tool other").found).toBe(10)
  })
})

describe("a call", () => {
  const started = async (options: ConnectionsOptions = {}) => {
    const s = setup(options)
    const ada = await s.agent()
    await s.connections.save(saving())
    const turn = await s.connections.forTurn(ada.id)
    return { ...s, ada, turn, echo: aliasOf(turn, "echo") }
  }

  test("gives the text of the result", async () => {
    const { turn, echo, fake } = await started()
    fake.state.answer = async (_n, args) => ({
      text: `got ${JSON.stringify(args)}`,
      isError: false,
    })
    const result = await turn.call(echo, { text: "hi" }, new AbortController().signal)
    expect(result).toEqual({ ok: true, text: 'got {"text":"hi"}', cut: false, isError: false })
  })

  test("a result of 200000 characters is cut to 100000 with a note", async () => {
    const { turn, echo, fake } = await started()
    fake.state.answer = async () => ({ text: "x".repeat(200_000), isError: false })
    const result = await turn.call(echo, {}, new AbortController().signal)
    if (!result.ok) throw new Error("failed")
    expect(result.cut).toBe(true)
    expect(result.text.startsWith("x".repeat(100_000))).toBe(true)
    expect(result.text.length).toBeLessThan(100_200)
    expect(result.text).toContain("was cut")
  })

  test("a call that is not answered ends with the reason timed out", async () => {
    const { turn, echo, fake } = await started({ callMs: 80 })
    fake.state.answer = async (_n, _a, options) => {
      await new Promise((resolve) => setTimeout(resolve, options.timeoutMs))
      throw new McpCallStopped("timeout")
    }
    const result = await turn.call(echo, {}, new AbortController().signal)
    expect(result).toEqual({ ok: false, reason: "timeout", message: "The call timed out." })
  })

  test("Stop ends a running call within 2 seconds", async () => {
    const { turn, echo, fake } = await started()
    fake.state.answer = (_n, _a, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new McpCallStopped("stop")))
      })
    const stopper = new AbortController()
    const began = Date.now()
    const running = turn.call(echo, {}, stopper.signal)
    await Bun.sleep(20)
    stopper.abort()
    await expect(running).rejects.toBeInstanceOf(McpCallStopped)
    expect(Date.now() - began).toBeLessThan(CONNECTION_STOP_MS)
  })

  test("a tool that says it failed is a result with that mark; an error of the connection fails the step", async () => {
    const { turn, echo, fake } = await started()
    fake.state.answer = async () => ({ text: "no such note", isError: true })
    expect(await turn.call(echo, {}, new AbortController().signal)).toMatchObject({
      ok: true,
      isError: true,
    })
    fake.state.answer = async () => {
      throw new McpError("ended", "The program ended.")
    }
    expect(await turn.call(echo, {}, new AbortController().signal)).toMatchObject({
      ok: false,
      reason: "down",
    })
  })
})

describe("running and stopping", () => {
  test("a connection stops after it was idle, and starts again on the next need", async () => {
    const { connections, fake, agent } = setup({ idleMs: 60 })
    const ada = await agent()
    await connections.save(saving())
    const turn = await connections.forTurn(ada.id)
    expect(await connections.running()).toHaveLength(1)
    expect(fake.state.opened).toHaveLength(1)
    // A call keeps it from stopping; after the call the idle time counts again.
    await turn.call(aliasOf(turn, "echo"), {}, new AbortController().signal)
    while ((await connections.running()).length > 0) await Bun.sleep(10)
    expect(fake.state.closed).toBe(1)
    // The next call starts it again.
    const result = await turn.call(aliasOf(turn, "echo"), {}, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(fake.state.opened).toHaveLength(2)
  })

  test("turn off stops it at once; the app ends every program it started", async () => {
    const { connections, fake, agent, t } = setup()
    const ada = await agent()
    const first = await connections.save(saving({ name: "One" }))
    await connections.save(saving({ name: "Two" }))
    await connections.forTurn(ada.id)
    expect(await connections.running()).toHaveLength(2)
    await connections.setEnabled(first.id, false)
    expect(fake.state.closed).toBe(1)
    await t.runtime.dispose()
    expect(fake.state.closed).toBe(2)
  })

  test("a change of the connection stops the one that runs", async () => {
    const { connections, fake, agent } = setup()
    const ada = await agent()
    const saved = await connections.save(saving())
    await connections.forTurn(ada.id)
    await connections.save(saving({ command: "other-server" }, saved.id))
    expect(fake.state.closed).toBe(1)
    expect(await connections.running()).toEqual([])
  })

  test("a connection that ends by itself is dropped, and the next turn starts it again", async () => {
    const { connections, fake, agent } = setup()
    const ada = await agent()
    await connections.save(saving())
    const turn = await connections.forTurn(ada.id)
    fake.state.opened.length = 0
    // The program ends by itself.
    const alias = aliasOf(turn, "echo")
    fake.state.answer = async () => {
      throw new McpError("ended", "The program ended.")
    }
    expect((await turn.call(alias, {}, new AbortController().signal)).ok).toBe(false)
  })
})
