#!/usr/bin/env node
// A stand-in for the `muse` program, for tests. It prints the same kinds of lines as the real one
// for the parts that the app uses. Its state is a JSON file next to it, so a test can change it.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const dir = dirname(new URL(import.meta.url).pathname)
const stateFile = join(dir, "muse-state.json")
const callsFile = join(dir, "muse-calls.jsonl")
const state = () =>
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { loggedIn: true }
const args = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (payload_type, payload) =>
  process.stdout.write(
    `${JSON.stringify({ schema_version: 1, record_type: "event", payload_type, payload })}\n`,
  )

if (args[0] === "--version") {
  console.log("Muse Code 9.9.9 (9.9.9-R1)")
  process.exit(0)
}

if (args[0] === "usage") {
  if (!state().loggedIn) {
    console.error("muse usage: not logged in: run `muse login` first")
    process.exit(1)
  }
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      allowance: {
        tier: "Muse Test Plan",
        window: { usedPercent: 12, resetsAtMs: Date.now() + 3_600_000 },
        weekly: { usedPercent: 34, resetsAtMs: Date.now() + 3 * 86_400_000 },
      },
      reason: null,
    }),
  )
  process.exit(0)
}

if (args[0] === "login") {
  appendFileSync(callsFile, `${JSON.stringify({ args, kind: "login" })}\n`)
  process.stderr.write(
    "\nOpen this page to sign in:\n  https://auth.meta.com/device\nEnter this code:\n  WXYZ-1234\n\nWaiting for approval (link expires in 10 minutes)... ",
  )
  await sleep(Number(process.env.FAKE_LOGIN_MS ?? 400))
  writeFileSync(stateFile, JSON.stringify({ ...state(), loggedIn: true }))
  process.stderr.write("Signed in.\n")
  process.exit(0)
}

if (args[0] === "exec") {
  const promptFile = args[args.indexOf("--prompt-file") + 1]
  const prompt = promptFile ? readFileSync(promptFile, "utf8") : ""
  appendFileSync(
    callsFile,
    `${JSON.stringify({ args, prompt, autoUpdate: process.env.MUSE_NO_AUTO_UPDATE ?? null })}\n`,
  )
  process.stderr.write("muse: skills loaded\n")
  const last = prompt.split("\n").at(-1)
  out("run.lifecycle.started", {})
  out("run.output.delta", { text: `Echo: ${last}` })
  out("run.usage", { models: [{ input_tokens: 20, output_tokens: 5 }] })
  out("run.terminal.completed", { terminal: "completed", text: `Echo: ${last}` })
  process.exit(0)
}

console.error(`unknown command: ${args.join(" ")}`)
process.exit(2)
