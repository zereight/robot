#!/usr/bin/env node
// A stand-in for the `opencode` program (version 2), for tests. Its state is a JSON file next to
// it. It speaks as the real program does: `models` lists one model on each line, and
// `run --format json` writes one event on each line.
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const dir = dirname(new URL(import.meta.url).pathname)
const stateFile = join(dir, "opencode-state.json")
const callsFile = join(dir, "opencode-calls.jsonl")
const state = () =>
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { ready: true }
const args = process.argv.slice(2)
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
// Every call is noted, so that a test can tell a check from a turn.
appendFileSync(join(dir, "opencode-asks.jsonl"), `${JSON.stringify(args.slice(0, 3))}\n`)

if (args[0] === "--version" || args[0] === "-v") {
  console.log(`opencode v${state().version ?? "2.9.9"}`)
  process.exit(0)
}

// Version 1 does not know the flag that keeps a call off the background server.
const needsStandalone = () => {
  if (!args.includes("--standalone")) {
    console.error("Unrecognized flag: this call must run with --standalone")
    process.exit(2)
  }
}

if (args[0] === "models") {
  needsStandalone()
  if (state().ready) {
    console.log("opencode/fake-free")
    console.log("anthropic/fake-large")
  }
  process.exit(0)
}

if (args[0] === "run") {
  needsStandalone()
  let prompt = ""
  for await (const chunk of process.stdin) prompt += chunk
  const config = process.env.OPENCODE_CONFIG_CONTENT
  appendFileSync(
    callsFile,
    `${JSON.stringify({
      args,
      prompt,
      cwd: process.cwd(),
      config: config ? JSON.parse(config) : null,
      // The text of the instruction file, read while the turn runs.
      instructions: (() => {
        try {
          return readFileSync(JSON.parse(config).instructions[0], "utf8")
        } catch {
          return null
        }
      })(),
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            (key.startsWith("OPENCODE_") && key !== "OPENCODE_CONFIG_CONTENT") ||
            key === "OPENAI_API_KEY",
        ),
      ),
    })}\n`,
  )
  const part = (type, more) => ({ id: `prt_${type}`, sessionID: "ses_1", type, ...more })
  const event = (type, p) => out({ type, timestamp: Date.now(), sessionID: "ses_1", part: p })
  event("step_start", part("step-start", {}))
  if (state().error) {
    out({
      type: "error",
      timestamp: Date.now(),
      sessionID: "ses_1",
      error: state().error,
    })
    process.exit(1)
  }
  event("reasoning", part("reasoning", { text: "Thinking it over." }))
  if (state().tool) {
    event("tool_use", {
      id: "call_1",
      sessionID: "ses_1",
      type: "tool",
      tool: state().tool.name,
      state: state().tool.state,
    })
  }
  event("text", part("text", { text: `Echo: ${prompt.split("\n").at(-1)}` }))
  event(
    "step_finish",
    part("step-finish", {
      reason: "stop",
      cost: 0,
      tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 2, write: 1 } },
    }),
  )
  process.exit(0)
}

console.error(`unknown command: ${args.join(" ")}`)
process.exit(2)
