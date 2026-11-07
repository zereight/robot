#!/usr/bin/env node
// A stand-in for the `pi` program, for tests. Its state is a JSON file next to it.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"

const dir = dirname(new URL(import.meta.url).pathname)
const stateFile = join(dir, "pi-state.json")
const callsFile = join(dir, "pi-calls.jsonl")
const state = () =>
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { ready: true }
const args = process.argv.slice(2)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
// Every call is noted, so that a test can tell a check from a turn.
appendFileSync(join(dir, "pi-asks.jsonl"), `${JSON.stringify(args.slice(0, 3))}\n`)

// The help text names `--tools` unless the test says that this program has no such mode.
if (args.includes("--help")) {
  console.log("pi - AI coding assistant\n\nOptions:\n  --model <pattern>  Model")
  if (!state().noReadOnly)
    console.log("  --tools, -t <tools>  Comma-separated allowlist of tool names to enable")
  process.exit(0)
}

if (args[0] === "--version" || args[0] === "-v") {
  console.log("9.9.9")
  process.exit(0)
}

if (args[0] === "--list-models") {
  if (!state().ready) {
    console.log("No models available. Use /login or set an API key.")
    process.exit(0)
  }
  console.log("provider       model        context  max-out  thinking  images")
  console.log("claude-bridge  fake-small   200K     64K      no        yes")
  console.log("anthropic      fake-large   200K     64K      yes       yes")
  process.exit(0)
}

if (args[0] === "--mode" && args[1] === "rpc") {
  // The levels of each model. "fake-large" takes a level that the old fixed list did not have.
  const levels = { "fake-small": ["off"], "fake-large": ["off", "low", "medium", "high", "xhigh"] }
  if (state().noRpc) process.exit(2)
  let model = null
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const command = JSON.parse(line)
    const reply = (success, data) =>
      out({ id: command.id, type: "response", command: command.type, success, data })
    if (command.type === "set_model") {
      if (command.modelId in levels) {
        model = command.modelId
        reply(true, { id: model })
      } else reply(false)
    } else if (command.type === "get_available_thinking_levels") {
      reply(true, { levels: levels[model] ?? ["off"] })
    } else reply(false)
  }
  process.exit(0)
}

if (args.includes("-p")) {
  let prompt = ""
  for await (const chunk of process.stdin) prompt += chunk
  // The text of the system file, read while the turn runs (the app removes it after).
  const at = args.indexOf("--append-system-prompt")
  let system = null
  try {
    system = at >= 0 ? readFileSync(args[at + 1], "utf8") : null
  } catch {
    system = null
  }
  appendFileSync(callsFile, `${JSON.stringify({ args, prompt, cwd: process.cwd(), system })}\n`)
  out({ type: "agent_start" })
  // A turn that the test tells to call a tool of the app: it reads the address of the bridge
  // from the extension file, calls it, and speaks the transcript lines of the call (spec 006).
  const wanted = state().bridgeCall
  const extAt = args.indexOf("--extension")
  if (wanted && extAt >= 0) {
    const src = readFileSync(args[extAt + 1], "utf8")
    const accessFile = JSON.parse(/readFileSync\((.*), "utf8"\)/.exec(src)[1])
    const access = JSON.parse(readFileSync(accessFile, "utf8"))
    const id = "bridge-call-1"
    out({ type: "tool_execution_start", toolCallId: id, toolName: wanted.name, args: wanted.args })
    const res = await fetch(access.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${access.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: wanted.name, arguments: wanted.args },
      }),
    })
    const body = await res.json()
    const text = (body.result?.content ?? []).map((c) => c.text ?? "").join("\n")
    out({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: wanted.name,
      isError: body.result?.isError === true,
      result: { content: [{ type: "text", text }] },
    })
  }
  out({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: `Echo: ${prompt.split("\n").at(-1)}` },
  })
  out({
    type: "turn_end",
    message: { stopReason: "stop", usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 } },
  })
  out({ type: "agent_settled" })
  process.exit(0)
}

console.error(`unknown command: ${args.join(" ")}`)
process.exit(2)
