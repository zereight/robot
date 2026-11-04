#!/usr/bin/env node
// A stand-in for the Cursor program. Its state is a JSON file next to it. It speaks as the real
// program does: `status --format json`, `models` as one model on a line, and `--print` with
// stream-json lines.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const dir = dirname(new URL(import.meta.url).pathname)
const stateFile = join(dir, "cursor-agent-state.json")
const callsFile = join(dir, "cursor-agent-calls.jsonl")
const state = () =>
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { signedIn: false }
const args = process.argv.slice(2)
appendFileSync(join(dir, "cursor-agent-asks.jsonl"), `${JSON.stringify(args.slice(0, 3))}\n`)

if (args.includes("--version") || args.includes("-v")) {
  console.log(state().version ?? "2026.10.22-test")
  process.exit(0)
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(state().help ?? "--mode <mode> choices: plan, ask. ask is read-only.")
  process.exit(0)
}

if (args[0] === "status") {
  const signedIn = state().signedIn === true
  console.log(
    JSON.stringify({
      status: signedIn ? "authenticated" : "unauthenticated",
      isAuthenticated: signedIn,
      ...(signedIn ? { userInfo: { email: state().email ?? "ada@example.com" } } : {}),
    }),
  )
  process.exit(0)
}

if (args[0] === "models") {
  if (state().signedIn !== true) {
    console.error("Authentication required")
    process.exit(1)
  }
  console.log("Available models")
  console.log("")
  console.log("composer-2.5 - Composer 2.5")
  console.log("gpt-5.5 - GPT-5.5")
  process.exit(0)
}

if (args.includes("-p") || args.includes("--print")) {
  const mark = args.indexOf("--")
  const prompt = mark >= 0 ? args.slice(mark + 1).join(" ") : ""
  appendFileSync(callsFile, `${JSON.stringify({ args, prompt })}\n`)
  const last = prompt.split("\n").at(-1) ?? ""
  const text = `Echo: ${last}`
  const line = (value) => console.log(JSON.stringify(value))
  line({
    type: "assistant",
    timestamp_ms: 1,
    message: { content: [{ type: "text", text }] },
  })
  line({ type: "result", subtype: "success", is_error: false, result: text })
  process.exit(0)
}

console.error(`unknown command: ${args.join(" ")}`)
process.exit(2)
