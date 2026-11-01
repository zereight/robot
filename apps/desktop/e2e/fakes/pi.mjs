#!/usr/bin/env node
// A stand-in for the `pi` program, for tests. Its state is a JSON file next to it.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const dir = dirname(new URL(import.meta.url).pathname)
const stateFile = join(dir, "pi-state.json")
const callsFile = join(dir, "pi-calls.jsonl")
const state = () =>
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { ready: true }
const args = process.argv.slice(2)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

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

if (args.includes("-p")) {
  let prompt = ""
  for await (const chunk of process.stdin) prompt += chunk
  appendFileSync(callsFile, `${JSON.stringify({ args, prompt })}\n`)
  out({ type: "agent_start" })
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
