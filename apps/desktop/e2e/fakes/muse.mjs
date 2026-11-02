#!/usr/bin/env node
// A stand-in for the `muse` program, for tests. It prints the same kinds of lines as the real one
// for the parts that the app uses. Its state is a JSON file next to it, so a test can change it.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"

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

// The session host: JSON-RPC, one message on each line. A prompt with "[ask]" makes the host ask
// for approval before it answers, and a prompt with "[fail]" ends the turn with an error.
if (args[0] === "serve") {
  const rpc = (message) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  const note = (method, params) => rpc({ method, params })
  const record = (entry) => appendFileSync(callsFile, `${JSON.stringify(entry)}\n`)
  let session = {}
  const decisions = new Map()
  const turn = async (params) => {
    const prompt = params.input.map((part) => part.text ?? "").join("")
    const last = prompt.split("\n").at(-1)
    record({
      args,
      prompt,
      autoUpdate: process.env.MUSE_NO_AUTO_UPDATE ?? null,
      foreignKill: process.env.MUSE_EXPERIMENTAL_FOREIGN_PERSONAL_CONTEXT_KILL ?? null,
      bridgeAuth: process.env.ROBOT_BRIDGE_AUTH ?? null,
      session,
      effort: params.reasoningEffort ?? null,
    })
    note("turn/started", { turnId: params.commandId })
    if (prompt.includes("[fail]")) {
      note("turn/completed", {
        turnId: params.commandId,
        terminal: "failed",
        error: { kind: "provider", message: "boom", retryable: false },
      })
      return
    }
    let answer = `Echo: ${last}`
    // The call opens before it waits for approval, as the real host does.
    const open = {
      itemId: "tool-1",
      kind: "toolCall",
      tool: "bash",
      args: JSON.stringify({ command: "ls" }),
    }
    note("item/started", { item: { ...open, status: "inProgress" } })
    // "[ask-other]" asks about another command, to show that a rule is not wider than its step.
    const other = prompt.includes("[ask-other]")
    if (prompt.includes("[ask]") || other) {
      rpc({
        id: 900,
        method: "approval/request",
        params: {
          approvalId: "approval-1",
          toolCallId: "call-1",
          itemId: "tool-1",
          toolName: "bash",
          rawArgs: "{}",
          subject: { kind: "shell", command: other ? "rm /etc/other-test" : "rm /etc/robot-test" },
          currentRequirementId: { approvalId: "approval-1", sourceIndex: 0 },
          availableChoices: [
            {
              choiceId: "allow-session",
              decision: "approvedForSession",
              scope: "session",
              label: "Allow for the session",
            },
            { choiceId: "allow-once", decision: "approved", scope: "once", label: "Allow once" },
            {
              choiceId: "deny",
              decision: "denied",
              scope: "once",
              label: "Deny",
              acceptsFeedback: true,
            },
          ],
        },
      })
      const decision = await new Promise((resolve) => decisions.set("approval-1", resolve))
      answer = decision.choiceId === "allow-once" ? "Ran it." : "Not allowed."
    }
    note("item/completed", { item: { ...open, status: "completed", visibleOutput: "a.txt" } })
    note("item/started", {
      item: { itemId: "message-1", kind: "agentMessage", status: "inProgress", text: "" },
    })
    note("item/delta", { itemId: "message-1", field: "text", delta: answer })
    note("session/tokenUsage", { usage: { inputTokens: 20, outputTokens: 5 } })
    note("item/completed", {
      item: { itemId: "message-1", kind: "agentMessage", status: "completed", text: answer },
    })
    // The reply is done. Reminder agents run on, and the app does not wait for them.
    note("turn/foregroundCompleted", {
      turnId: params.commandId,
      blockingAgents: ["goal-reminder"],
    })
  }
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line)
    if (message.method === "initialize")
      rpc({ id: message.id, result: { serverInfo: { name: "muse", version: "9.9.9" } } })
    else if (message.method === "session/start") {
      session = { ...message.params, commandId: undefined }
      rpc({ id: message.id, result: { session: { sessionId: "session-1" } } })
    } else if (message.method === "turn/start") {
      rpc({ id: message.id, result: { status: "accepted", turnId: message.params.commandId } })
      void turn(message.params)
    } else if (message.method === "approval/decide") {
      record({ kind: "decide", params: message.params })
      rpc({ id: message.id, result: { status: "accepted", terminal: true } })
      decisions.get(message.params.approvalId)?.(message.params)
    }
  }
  process.exit(0)
}

console.error(`unknown command: ${args.join(" ")}`)
process.exit(2)
