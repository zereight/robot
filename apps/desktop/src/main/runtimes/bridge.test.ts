import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname } from "node:path"
import { createInterface } from "node:readline"
import { ownTempRoot } from "../stale-temp.ts"
import {
  type BridgeGrant,
  type BridgeHandler,
  bridgeToolName,
  codexBridgeArgs,
  grantBridge,
  MUSE_AUTH_VARIABLE,
  museBridge,
  removeAllStaged,
  SHIM,
  type Staged,
  stage,
  stdioServer,
} from "./bridge.ts"

const calls: { name: string; args: unknown }[] = []
const handler: BridgeHandler = {
  tools: [
    {
      name: "browser_read",
      description: "Read the page.",
      schema: { type: "object", properties: {} },
    },
    {
      name: "browser_open",
      description: "Open a page.",
      schema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  ],
  call: async (name, args, signal) => {
    calls.push({ name, args })
    if (args.url === "stall") await new Promise((r) => signal.addEventListener("abort", r))
    if (args.url === "throw") throw new Error("boom")
    return { output: `ran ${name}`, failed: args.url === "bad" }
  },
}

let grant: BridgeGrant | undefined
let staged: Staged | undefined
afterEach(() => {
  grant?.release()
  grant = undefined
  staged?.remove()
  staged = undefined
  calls.length = 0
})

const post = (g: BridgeGrant, body: unknown, token = g.token) =>
  fetch(g.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
const rpc = async (g: BridgeGrant, method: string, params?: unknown) =>
  (await (await post(g, { jsonrpc: "2.0", id: 7, method, params })).json()) as {
    id: number
    result?: Record<string, unknown>
    error?: { code: number; message: string }
  }

describe("the MCP server of the app", () => {
  test("initializes, lists the tools and calls one", async () => {
    grant = await grantBridge(handler)
    const init = await rpc(grant, "initialize", { protocolVersion: "2025-03-26" })
    expect(init.id).toBe(7)
    expect(init.result?.protocolVersion).toBe("2025-03-26")
    expect(init.result?.capabilities).toEqual({ tools: {} })

    const list = await rpc(grant, "tools/list")
    expect(((list.result?.tools ?? []) as { name: string }[]).map((t) => t.name)).toEqual([
      "browser_read",
      "browser_open",
    ])

    const done = await rpc(grant, "tools/call", {
      name: "browser_open",
      arguments: { url: "https://example.com" },
    })
    expect(done.result).toEqual({
      content: [{ type: "text", text: "ran browser_open" }],
      isError: false,
    })
    expect(calls).toEqual([{ name: "browser_open", args: { url: "https://example.com" } }])
  })

  test("a failed tool is an error result, and a thrown error does not break the server", async () => {
    grant = await grantBridge(handler)
    const bad = await rpc(grant, "tools/call", { name: "browser_open", arguments: { url: "bad" } })
    expect(bad.result?.isError).toBe(true)
    const thrown = await rpc(grant, "tools/call", {
      name: "browser_open",
      arguments: { url: "throw" },
    })
    expect(thrown.result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true })
    expect((await rpc(grant, "ping")).result).toEqual({})
  })

  test("refuses an unknown tool and an unknown method", async () => {
    grant = await grantBridge(handler)
    expect((await rpc(grant, "tools/call", { name: "run_command" })).error?.code).toBe(-32602)
    expect((await rpc(grant, "resources/list")).error?.code).toBe(-32601)
  })

  test("a notification gets no body", async () => {
    grant = await grantBridge(handler)
    const res = await post(grant, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(res.status).toBe(202)
  })

  test("refuses a call without the token of the turn", async () => {
    grant = await grantBridge(handler)
    const body = { jsonrpc: "2.0", id: 1, method: "tools/list" }
    expect((await post(grant, body, "wrong")).status).toBe(401)
    const bare = await fetch(grant.url, { method: "POST", body: JSON.stringify(body) })
    expect(bare.status).toBe(401)
    expect((await fetch(grant.url)).status).toBe(405)
    expect(calls).toEqual([])
  })

  test("two turns have two tokens, and each token reaches its own handler", async () => {
    const other: BridgeHandler = {
      tools: handler.tools,
      call: async () => ({ output: "other", failed: false }),
    }
    grant = await grantBridge(handler)
    const second = await grantBridge(other)
    expect(second.token).not.toBe(grant.token)
    const reply = await rpc(second, "tools/call", { name: "browser_read" })
    expect(reply.result?.content).toEqual([{ type: "text", text: "other" }])
    second.release()
    // The first turn still works after the second one ended.
    expect((await rpc(grant, "ping")).result).toEqual({})
  })

  test("stops listening when the last turn ends", async () => {
    const g = await grantBridge(handler)
    expect((await rpc(g, "ping")).result).toEqual({})
    g.release()
    await expect(post(g, { jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow()
    // A new turn opens it again.
    grant = await grantBridge(handler)
    expect((await rpc(grant, "ping")).result).toEqual({})
  })

  test("a program that drops the connection stops the call", async () => {
    grant = await grantBridge(handler)
    const controller = new AbortController()
    const pending = fetch(grant.url, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "browser_open", arguments: { url: "stall" } },
      }),
      signal: controller.signal,
    }).catch(() => "aborted")
    await new Promise((r) => setTimeout(r, 100))
    controller.abort()
    expect(await pending).toBe("aborted")
    // The server is free for the next call.
    expect((await rpc(grant, "ping")).result).toEqual({})
  })
})

describe("the script for programs that start servers", () => {
  test("carries a conversation between a program and the app", async () => {
    grant = await grantBridge(handler)
    staged = stage(grant)
    const child = spawn(process.execPath, ["-e", SHIM, staged.accessFile], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    })
    const lines = createInterface({ input: child.stdout })
    const answers = new Map<number, Record<string, unknown>>()
    const waiting = new Map<number, () => void>()
    lines.on("line", (line) => {
      const message = JSON.parse(line) as { id: number }
      answers.set(message.id, message)
      waiting.get(message.id)?.()
    })
    const ask = (id: number, method: string, params?: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        waiting.set(id, () => resolve(answers.get(id) ?? {}))
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      })
    try {
      expect(
        (
          (await ask(1, "initialize", { protocolVersion: "2025-06-18" })).result as {
            serverInfo: { name: string }
          }
        ).serverInfo.name,
      ).toBe("robot")
      // A notification has no answer, so the next answer is not held back.
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      )
      const done = await ask(2, "tools/call", { name: "browser_read", arguments: {} })
      expect(done.result).toEqual({
        content: [{ type: "text", text: "ran browser_read" }],
        isError: false,
      })
    } finally {
      child.kill()
    }
  })

  test("answers with an error when the app is gone", async () => {
    const g = await grantBridge(handler)
    staged = stage(g)
    g.release()
    const child = spawn(process.execPath, ["-e", SHIM, staged.accessFile], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`)
    const line = await new Promise<string>((resolve) =>
      createInterface({ input: child.stdout }).once("line", resolve),
    )
    child.kill()
    expect(JSON.parse(line)).toMatchObject({ id: 3, error: { code: -32000 } })
  })
})

describe("files of a run", () => {
  test("hold the token, can be read by the user only, and go away", async () => {
    grant = await grantBridge(handler)
    staged = stage(grant)
    for (const file of [staged.accessFile, staged.claudeConfig, staged.piExtension])
      expect(statSync(file).mode & 0o077).toBe(0)
    expect(JSON.parse(readFileSync(staged.accessFile, "utf8"))).toEqual({
      url: grant.url,
      token: grant.token,
    })
    expect(JSON.parse(readFileSync(staged.claudeConfig, "utf8"))).toEqual({
      mcpServers: {
        robot: {
          type: "http",
          url: grant.url,
          headers: { Authorization: `Bearer ${grant.token}` },
        },
      },
    })
    const extension = readFileSync(staged.piExtension, "utf8")
    expect(extension).toContain("registerTool")
    expect(extension).toContain('"browser_open"')
    const file = staged.accessFile
    staged.remove()
    expect(() => statSync(file)).toThrow()
  })

  test("stand in the folder of the app, and the name of the folder holds the process number", async () => {
    grant = await grantBridge(handler)
    staged = stage(grant)
    const folder = dirname(staged.accessFile)
    expect(dirname(folder)).toBe(ownTempRoot() as string)
    // A later start reads the number to tell that a folder of a killed app is dead.
    expect(basename(folder)).toMatch(new RegExp(`^robot-bridge-${process.pid}-[A-Za-z0-9]{6}$`))
  })

  test("a file that cannot be written leaves no folder with a token", async () => {
    grant = await grantBridge(handler)
    const root = ownTempRoot() as string
    const before = readdirSync(root).sort()
    // A value that JSON cannot hold: the second file fails after the first one is written.
    const broken = {
      ...grant,
      tools: [{ ...handler.tools[0], schema: 1n }],
    } as unknown as BridgeGrant
    expect(() => stage(broken)).toThrow()
    expect(readdirSync(root).sort()).toEqual(before)
  })

  test("the quit removes the folders of the runs that are still going, and no other", async () => {
    grant = await grantBridge(handler)
    const going = [stage(grant), stage(grant)]
    const ended = stage(grant)
    ended.remove()
    const other = stage(grant)
    expect(going.every((s) => existsSync(s.accessFile))).toBe(true)
    removeAllStaged()
    for (const s of [...going, other]) expect(existsSync(s.accessFile)).toBe(false)
    // A second call, with nothing left, does nothing.
    expect(() => removeAllStaged()).not.toThrow()
  })

  test("the token is in no argument of a program", async () => {
    grant = await grantBridge(handler)
    staged = stage(grant)
    const args = [...codexBridgeArgs(staged), ...museBridge(grant).args].join("\n")
    expect(args).not.toContain(grant.token)
    expect(args).toContain(staged.accessFile)
  })
})

describe("settings for each program", () => {
  const staged = { accessFile: "/tmp/robot-x/access.json" } as Staged

  test("Codex gets one setting per part, each a valid JSON and TOML value", () => {
    const args = codexBridgeArgs(staged)
    const server = stdioServer(staged.accessFile)
    expect(args).toEqual([
      "-c",
      `mcp_servers.robot.command=${JSON.stringify(server.command)}`,
      "-c",
      `mcp_servers.robot.args=${JSON.stringify(server.args)}`,
      "-c",
      'mcp_servers.robot.env.ELECTRON_RUN_AS_NODE="1"',
    ])
    expect(JSON.parse(args[3]?.split("args=")[1] ?? "")).toEqual(server.args)
  })

  test("Muse Code gets one setting for the one server, and the token in its environment", () => {
    const access = { url: "http://127.0.0.1:5000/mcp", token: "t0k3n", tools: [] }
    const { args, env } = museBridge(access)
    expect(args[0]).toBe("-c")
    expect(args[1]?.startsWith("mcpServers.robot={")).toBe(true)
    // The program takes a secret of a setting only as the whole value of a variable.
    expect(JSON.parse(args[1]?.slice("mcpServers.robot=".length) ?? "")).toEqual({
      url: access.url,
      headers: { Authorization: `\${${MUSE_AUTH_VARIABLE}}` },
    })
    expect(args.join(" ")).not.toContain("t0k3n")
    expect(env).toEqual({ [MUSE_AUTH_VARIABLE]: "Bearer t0k3n" })
  })
})

describe("names of the tools", () => {
  test("a program shows the name of the server before the tool", () => {
    expect(bridgeToolName("browser_open")).toBe("browser_open")
    expect(bridgeToolName("mcp__robot__browser_read")).toBe("browser_read")
    expect(bridgeToolName("robot.browser_click")).toBe("browser_click")
    expect(bridgeToolName("robot/browser_type")).toBe("browser_type")
    expect(bridgeToolName("Robot-browser_close")).toBe("browser_close")
  })

  test("other tools and other servers do not match", () => {
    expect(bridgeToolName("bash")).toBeNull()
    expect(bridgeToolName("mcp__other__browser_open")).toBeNull()
    expect(bridgeToolName("robotbrowser_open")).toBeNull()
    expect(bridgeToolName("mcp__robotics__browser_open")).toBeNull()
    expect(bridgeToolName("my_browser_open")).toBeNull()
    expect(bridgeToolName("")).toBeNull()
  })
})
