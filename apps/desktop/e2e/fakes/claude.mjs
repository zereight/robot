#!/usr/bin/env node
// A stand-in for the `claude` program, for tests. It speaks the same lines as the real one for
// the parts that the app uses. Its state is a JSON file next to it, so a test can change it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"

const dir = dirname(new URL(import.meta.url).pathname)
const stateFile = join(dir, "claude-state.json")
const callsFile = join(dir, "claude-calls.jsonl")
// The looks at the usage have a file of their own: they run beside the turns, in any order.
const usageCallsFile = join(dir, "claude-usage-calls.jsonl")
// A separate sign-in has a folder of its own, like the real program with `CLAUDE_CONFIG_DIR`. Its
// state lives in that folder, and nobody is signed in until the program signs in there.
const configDir = process.env.CLAUDE_CONFIG_DIR || null
const profileFile = configDir ? join(configDir, "fake-state.json") : null
const globalState = () =>
  existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { loggedIn: true, authMethod: "claude.ai", email: "tester@example.com", plan: "max" }
const state = () =>
  profileFile
    ? existsSync(profileFile)
      ? JSON.parse(readFileSync(profileFile, "utf8"))
      : { loggedIn: false }
    : globalState()
const args = process.argv.slice(2)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (args[0] === "--version") {
  console.log("9.9.9 (Claude Code)")
  process.exit(0)
}

if (args[0] === "auth" && args[1] === "status") {
  // A program that does not answer its check: the state says `hang`.
  if (state().hang) await sleep(120_000)
  const s = state()
  console.log(
    JSON.stringify(
      s.loggedIn
        ? {
            loggedIn: true,
            authMethod: s.authMethod,
            apiProvider: "firstParty",
            email: s.email,
            subscriptionType: s.plan,
          }
        : { loggedIn: false },
    ),
  )
  process.exit(0)
}

if (args[0] === "auth" && args[1] === "login") {
  appendFileSync(callsFile, `${JSON.stringify({ args, kind: "login", configDir })}\n`)
  await sleep(Number(process.env.FAKE_LOGIN_MS ?? 400))
  if (globalState().loginFails) {
    console.error("Login failed")
    process.exit(1)
  }
  if (profileFile) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      profileFile,
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: globalState().profileEmail ?? "second@example.com",
        plan: "pro",
      }),
    )
  } else {
    writeFileSync(
      stateFile,
      JSON.stringify({
        ...state(),
        loggedIn: true,
        authMethod: "claude.ai",
        email: "tester@example.com",
      }),
    )
  }
  process.exit(0)
}

if (args[0] === "auth" && args[1] === "logout") {
  appendFileSync(callsFile, `${JSON.stringify({ args, kind: "logout", configDir })}\n`)
  if (profileFile) rmSync(profileFile, { force: true })
  process.exit(0)
}

// `claude -p "/usage"`: the program answers by itself, without a model. The state gives the text
// in `usageText`; with none, the text has no window, like an account that the vendor does not report.
if (args[0] === "-p" && args[1] === "/usage") {
  appendFileSync(
    usageCallsFile,
    `${JSON.stringify({ kind: "usage-text", args, cwd: process.cwd(), configDir })}\n`,
  )
  const text = state().usageText ?? "You are currently using your subscription.\n"
  out({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 0 })
  process.exit(0)
}

// A turn: the first line on stdin is the user's message.
const lines = createInterface({ input: process.stdin })
const waiting = new Map()
let first = true
const received = []
/**
 * Messages of the user that came during the turn, as the real program keeps them: it tells
 * "queued" at once, and "started" when it reads one, after its reply (spec 003).
 */
const later = []
let answered = false
const drain = () => {
  while (later.length > 0) {
    const msg = later.shift()
    if (msg.uuid) lifecycle(msg.uuid, "started")
    const text = (msg.message.content ?? []).map((b) => b.text ?? "").join("")
    appendFileSync(callsFile, `${JSON.stringify({ joined: text, uuid: msg.uuid ?? null })}\n`)
    delta(`Joined: ${text}`)
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 3, output_tokens: 2 },
    })
    if (msg.uuid) lifecycle(msg.uuid, "completed")
  }
}
const lifecycle = (id, state) => {
  if (args.includes("--replay-user-messages"))
    out({ type: "command_lifecycle", command_uuid: id, state })
}
lines.on("line", (line) => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (msg.type === "control_response") {
    waiting.get(msg.response.request_id)?.(msg.response.response)
    return
  }
  if (msg.type === "control_request" && msg.request?.subtype === "get_usage") {
    // The state gives the windows in `usage`; with none, `rate_limits` is null, as when the
    // vendor cannot be reached.
    appendFileSync(
      usageCallsFile,
      `${JSON.stringify({ kind: "usage", args, cwd: process.cwd(), configDir })}\n`,
    )
    out({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: msg.request_id,
        response: {
          session: { total_cost_usd: 0 },
          subscription_type: state().plan ?? null,
          rate_limits_available: true,
          rate_limits: state().usage ?? null,
        },
      },
    })
    return
  }
  if (msg.type === "user" && first) {
    first = false
    void turn(msg.message.content)
  } else if (msg.type === "user") {
    later.push(msg)
    if (msg.uuid) lifecycle(msg.uuid, "queued")
    // After its reply the program reads a new message at once.
    if (answered) drain()
  }
  received.push(msg)
})

const limits = (status = "allowed", used = 0.19) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status,
    resetsAt: 1_900_000_000,
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: used, resetsAt: 1_900_000_000, status },
      seven_day: { utilization: 0.4, resetsAt: 1_900_500_000, status: "allowed" },
    },
  },
})

const delta = (text) =>
  out({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  })

// The message is a text, or a list of text blocks, as the real program takes both.
async function turn(content) {
  const blocks = Array.isArray(content)
    ? content.map((b) => String(b.text ?? ""))
    : [String(content)]
  const prompt = blocks.join("\n\n")
  appendFileSync(
    callsFile,
    `${JSON.stringify({
      args,
      cwd: process.cwd(),
      prompt,
      blocks,
      configDir,
      // A test finds the process of this turn by it.
      pid: process.pid,
      hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    })}\n`,
  )
  out({ type: "system", subtype: "init", model: "fake", permissionMode: "default" })
  const tool = /RUN:(.+)/.exec(prompt)
  if (/LIMIT/.test(prompt)) {
    out(limits("rejected", 1))
    out({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your limit ∙ resets 3pm",
      usage: {},
    })
    process.exit(0)
  }
  if (/SLOW/.test(prompt)) {
    delta("Thinking slowly")
    await sleep(60_000)
  }
  // A turn that works for a while, so that a message can come during it.
  if (/WAIT/.test(prompt)) {
    delta("Working. ")
    await sleep(Number(/WAIT (\d+)/.exec(prompt)?.[1] ?? 800))
  }
  const browser = /BROWSER:(\w+)(?: (\{.*\}))?/.exec(prompt)
  if (browser) {
    // A tool of the app: the program reads the server from the file it was given, and asks.
    const server = JSON.parse(readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"))
      .mcpServers.robot
    const id = "toolu_fake_mcp"
    const name = `mcp__robot__${browser[1]}`
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: {} }] } })
    await new Promise((resolve) => {
      waiting.set("req_mcp", resolve)
      out({
        type: "control_request",
        request_id: "req_mcp",
        request: { subtype: "can_use_tool", tool_name: name, tool_use_id: id, input: {} },
      })
    })
    const reply = await (
      await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...server.headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: browser[1], arguments: JSON.parse(browser[2] ?? "{}") },
        }),
      })
    ).json()
    const text = reply.result.content.map((c) => c.text).join("\n")
    out({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: id, is_error: reply.result.isError, content: text },
        ],
      },
    })
    delta(`Page: ${text}`)
  } else if (tool) {
    const command = tool[1].trim()
    const id = "toolu_fake1"
    out({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
    })
    const answer = await new Promise((resolve) => {
      waiting.set("req1", resolve)
      out({
        type: "control_request",
        request_id: "req1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          tool_use_id: id,
          input: { command },
        },
      })
    })
    const allowed = answer.behavior === "allow"
    out({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: !allowed,
            content: allowed ? "tool output" : "The user denied this step.",
          },
        ],
      },
    })
    delta(allowed ? "It ran." : "It was denied.")
  } else {
    // The text of the last message of the user, without its label and without the notes.
    const last = (blocks.at(-1) ?? "")
      .split("\n\nNotes from the app")[0]
      .split("\n")
      .at(-1)
      .replace(/^User: /, "")
    delta("Echo: ")
    await sleep(30)
    delta(last)
  }
  out(limits())
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 7 },
  })
  // The messages that came during the turn are read now, one after another, each with a result.
  answered = true
  drain()
  // A program that takes messages during a turn goes on reading them; the app ends the input.
  if (!args.includes("--replay-user-messages")) process.stdin.pause()
}

// The state can say `survive`: the program then stays up when the app that started it is gone.
lines.on("close", () => {
  if (!state().survive) process.exit(0)
})
