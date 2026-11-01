#!/usr/bin/env node
// A stand-in for the `codex` program, for tests. The state is a JSON file next to it.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const dir = dirname(new URL(import.meta.url).pathname)
const stateFile = join(dir, "codex-state.json")
const callsFile = join(dir, "codex-calls.jsonl")
const state = () =>
  existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { loggedIn: true, method: "chatgpt" }
const args = process.argv.slice(2)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (args[0] === "--version") {
  console.log("codex-cli 9.9.9")
  process.exit(0)
}

if (args[0] === "login" && args[1] === "status") {
  const s = state()
  if (!s.loggedIn) {
    console.error("Not logged in")
    process.exit(1)
  }
  console.error(
    s.method === "chatgpt" ? "Logged in using ChatGPT" : "Logged in using an API key - sk-***",
  )
  process.exit(0)
}

if (args[0] === "login") {
  await sleep(Number(process.env.FAKE_LOGIN_MS ?? 400))
  writeFileSync(stateFile, JSON.stringify({ loggedIn: true, method: "chatgpt" }))
  process.exit(0)
}

if (args[0] === "exec") {
  let prompt = ""
  for await (const chunk of process.stdin) prompt += chunk
  appendFileSync(
    callsFile,
    `${JSON.stringify({ args, cwd: process.cwd(), prompt, hasApiKey: Boolean(process.env.OPENAI_API_KEY) })}\n`,
  )
  out({ type: "thread.started", thread_id: "t1" })
  out({ type: "turn.started" })
  if (/FAIL/.test(prompt)) {
    out({ type: "error", message: "Reconnecting… 1/5" })
    out({ type: "turn.failed", error: { message: "You've hit your usage limit." } })
    process.exit(1)
  }
  if (/SLOW/.test(prompt)) await sleep(60_000)
  const tool = /RUN:(.+)/.exec(prompt)
  if (tool) {
    const item = { id: "item_1", type: "command_execution", command: tool[1].trim() }
    out({ type: "item.started", item: { ...item, status: "in_progress" } })
    await sleep(30)
    out({
      type: "item.completed",
      item: { ...item, aggregated_output: "tool output", exit_code: 0, status: "completed" },
    })
  }
  const last = prompt.split("\n").filter(Boolean).at(-1)
  out({
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: `Echo: ${last}` },
  })
  out({
    type: "turn.completed",
    usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3 },
  })
  process.exit(0)
}

process.exit(2)
