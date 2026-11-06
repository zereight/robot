import { mkdirSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  launch,
  resizeWindow,
  shotsDir,
  startRecording,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The pictures of the README. This file is not a check. It starts the real app against a scripted
// stand-in model, makes a few agents, and saves one picture of each screen that the README shows
// to build/e2e/readme. It runs only when README_SHOTS is set, so the normal suite skips it:
//
//   README_SHOTS=1 bun run --cwd apps/desktop e2e e2e/readme-shots.spec.ts
//
// The replies in the pictures come from the script below, not from a real model. The pictures are
// PNG files at twice the pixel size of the window. The README uses JPEG files of 1400 px width;
// see "Screenshots" in README.md for the commands that make them.

test.skip(!process.env.README_SHOTS, "Makes the pictures of the README. Set README_SHOTS=1.")

const outDir = join(shotsDir, "..", "readme")
const pic = async (page: Page, name: string) => {
  mkdirSync(outDir, { recursive: true })
  await page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled" })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- The scripted model -------------------------------------------------------------------------

interface Scripted {
  /** The reply. */
  readonly text: string
  /** The wait between two words, in ms. */
  readonly delay?: number
  /** A call of a tool at the end of the reply. A step that needs approval waits for the user. */
  readonly toolCall?: { readonly name: string; readonly args: Record<string, unknown> }
}

const CHAT_REPLY = [
  "Here is a plan for the 1.2 docs. It takes about two hours.",
  "",
  "1. **Collect the changes.** List what changed since 1.1.",
  "2. **Draft the notes.** Bo writes the first draft from that list.",
  "3. **Check.** Cy checks every fact and every link.",
  "4. **Publish.** You approve, then the notes go to the handbook.",
  "",
  "Start with the list of changes:",
  "",
  "```sh",
  "git log v1.1.0..HEAD --oneline --no-merges",
  "```",
  "",
  "| Step | Owner | Time |",
  "| --- | --- | --- |",
  "| Collect the changes | Ada | 10 min |",
  "| Draft the notes | Bo | 45 min |",
  "| Check facts and links | Cy | 30 min |",
  "| Publish | You | 5 min |",
  "",
  "Tell me when the list is ready and I will hand the draft to Bo.",
].join("\n")

const COPY_ASK = "I will copy the notes to the docs server. The copy needs your approval."

/** What the scripted model answers, by the last line of the last message of the user. */
const scripted = (line: string): Scripted | undefined => {
  if (line.startsWith("Copy the release notes to the docs server"))
    return {
      text: COPY_ASK,
      delay: 20,
      toolCall: {
        name: "run_command",
        args: { command: "sudo cp notes.md /srv/docs/release-notes.md" },
      },
    }
  if (line.includes("ship the 1.2 docs")) return { text: CHAT_REPLY, delay: 8 }
  return undefined
}

const streamScripted = async (res: ServerResponse, reply: Scripted) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  const parts = reply.text.match(/\S+\s*/g) ?? [reply.text]
  for (const part of parts) {
    if (res.destroyed) return
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
    if (reply.delay) await sleep(reply.delay)
  }
  if (reply.toolCall) {
    const first = { index: 0, id: "call_1", function: { name: reply.toolCall.name, arguments: "" } }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [first] } }] })}\n\n`)
    const rest = { index: 0, function: { arguments: JSON.stringify(reply.toolCall.args) } }
    return res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [rest] } }] })}\n\ndata: [DONE]\n\n`,
    )
  }
  res.write(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 420, completion_tokens: parts.length } })}\n\n`,
  )
  res.end("data: [DONE]\n\n")
}

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b: { text?: unknown }) => (typeof b.text === "string" ? b.text : "")).join("")
      : ""

/**
 * A model provider in front of the stand-in of the end-to-end tests. It answers the requests that
 * the pictures need with the text above and passes every other request (tool calls) on to the
 * stand-in. Its one model is called "demo-model".
 */
const startDemoProvider = async (upstream: string) => {
  const origin = new URL(upstream).origin
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    if (req.method === "GET" && path === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ data: [{ id: "demo-model", context_length: 200_000 }] }))
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const body = JSON.parse(raw.toString("utf8") || "{}") as {
        messages?: { role: string; content: unknown }[]
      }
      const last = body.messages?.at(-1)
      const reply =
        last?.role === "user" ? scripted(textOf(last.content).split("\n").at(-1) ?? "") : undefined
      if (reply) return streamScripted(res, reply)
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([k, v]) => typeof v === "string" && !["host", "content-length", "connection"].includes(k),
      ),
    ) as Record<string, string>
    const method = req.method ?? "GET"
    const answer = await fetch(`${origin}${req.url}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: raw }),
    })
    res.writeHead(answer.status, {
      "content-type": answer.headers.get("content-type") ?? "text/plain",
    })
    for await (const chunk of answer.body ?? []) {
      if (res.destroyed) return
      res.write(chunk)
    }
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

// ---- The agents --------------------------------------------------------------------------------

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string

const idle = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })

test("readme: pictures of the app", async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const demo = await startDemoProvider(mock.openaiUrl)
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1400, 900)
  await rpc(page, "settings.update", { theme: "dark", language: "en" })
  await connectMock(page, demo.url, GOOD_KEY, "Demo model")

  // The agents: a planner of the docs, a writer, a fact checker and a keeper of the release plan.
  await createAgent(page, "Ada")
  const serverId = await serverOf(page)
  const ada = (await rpc<AgentInfo[]>(page, "agents.list", { serverId, archived: false }))[0]
  if (!ada) throw new Error("no agent")
  await rpc(page, "agents.update", {
    id: ada.id,
    patch: { role: "Plans the docs work", face: { shape: 0, hue: 3 } },
  })
  const made: Record<string, string> = {}
  for (const [name, role, shape, hue] of [
    ["Bo", "Writes the first draft", 1, 6],
    ["Cy", "Checks facts and links", 3, 1],
    ["Dee", "Keeps the release plan", 5, 8],
  ] as const) {
    const agent = await rpc<AgentInfo>(page, "agents.create", {
      serverId,
      name,
      role,
      instructions: "",
      face: { shape, hue },
      model: ada.model,
    })
    made[name] = agent.id
  }
  const [bo, cy, dee] = [made.Bo, made.Cy, made.Dee] as [string, string, string]

  // 1. A direct chat with a Markdown reply. The chat is also filmed: build/e2e/videos/readme-demo.gif
  // when ffmpeg is on the PATH.
  await page.getByTestId(`place-agent-${ada.id}`).click()
  const stopFilm = await startRecording(page, "readme-demo")
  await page.waitForTimeout(700)
  await page.getByTestId("composer-input").click()
  await page
    .getByTestId("composer-input")
    .pressSequentially("Outline how we ship the 1.2 docs: who does what, and the first command.", {
      delay: 30,
    })
  await page.getByTestId("composer-input").press("Enter")
  await idle(page)
  await page.waitForTimeout(1500)
  await pic(page, "chat")
  await stopFilm()

  // 2. One hand-off from Bo to Cy, then Dee waits for an answer. The command of Dee asks for
  // approval, and the script never allows it.
  await rpc(page, "chat.send", {
    agentId: bo,
    text: 'TOOL send_message {"to":"Cy","text":"Please check the facts"}',
    replyTo: null,
  })
  await expect
    .poll(
      async () => {
        const tasks = (
          await rpc<{ source: string; state: string }[]>(page, "tasks.list", { serverId })
        ).filter((t) => t.source === "agent")
        return tasks.length > 0 && tasks.every((t) => t.state === "done")
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await rpc(page, "chat.send", {
    agentId: dee,
    text: "Copy the release notes to the docs server.",
    replyTo: null,
  })
  await page.getByTestId(`place-agent-${dee}`).click()
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(600)
  await pic(page, "approval")

  // 3. Routines, and a workflow.
  await rpc(page, "routines.create", {
    serverId,
    agentId: bo,
    name: "Morning briefing",
    prompt: "Write a short briefing of the news that matter for the docs team.",
    schedule: { kind: "daily", times: ["08:30"] },
    place: { kind: "agent" },
  })
  await rpc(page, "routines.create", {
    serverId,
    agentId: ada.id,
    name: "Friday report",
    prompt: "Sum up what the team shipped this week.",
    schedule: { kind: "weekly", days: [5], time: "17:00" },
    place: { kind: "agent" },
  })
  await rpc(page, "routines.create", {
    serverId,
    agentId: cy,
    name: "Link check",
    prompt: "Check the links of the handbook and list the broken ones.",
    schedule: { kind: "every", minutes: 360, from: Date.now() },
    place: { kind: "agent" },
  })
  await page.getByTestId("page-routines").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(3)
  await pic(page, "routines")
  await rpc(page, "workflows.create", {
    serverId,
    name: "Release notes",
    trigger: { kind: "manual" },
    steps: [
      {
        id: "draft",
        kind: "agent",
        name: "Draft",
        x: 0,
        y: 240,
        agentId: bo,
        prompt: "Write the release notes for version 1.2.",
        continueOnFailure: false,
      },
      {
        id: "check",
        kind: "agent",
        name: "Check the facts",
        x: 220,
        y: 240,
        agentId: cy,
        prompt: "Check the facts and the links in this draft:\n{{input}}",
        continueOnFailure: false,
      },
      {
        id: "ok",
        kind: "condition",
        name: "Facts hold?",
        x: 440,
        y: 240,
        contains: "ready",
        mode: "contains",
      },
      {
        id: "approve",
        kind: "approval",
        name: "Ask me",
        x: 660,
        y: 80,
        message: "Post these release notes?",
      },
      {
        id: "done",
        kind: "notify",
        name: "Notes approved",
        x: 880,
        y: 80,
        title: "Notes approved",
      },
      { id: "notify", kind: "notify", name: "Tell me", x: 660, y: 400, title: "Facts need a look" },
    ],
    edges: [
      { id: "e1", from: "draft", to: "check" },
      { id: "e2", from: "check", to: "ok" },
      { id: "e3", from: "ok", to: "approve", branch: "yes" },
      { id: "e4", from: "approve", to: "done" },
      { id: "e5", from: "ok", to: "notify", branch: "no" },
    ],
    notes: [
      {
        id: "n1",
        text: "A person decides before the notes go out.",
        tone: "yellow",
        x: 660,
        y: 540,
      },
    ],
  })
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-open").first().click()
  await expect(page.getByTestId("wf-node").first()).toBeVisible()
  for (let i = 0; i < 3; i++) await page.getByTestId("wf-zoom-out").click()
  // A click on a step opens its form at the right.
  await page.getByTestId("wf-node").nth(1).click()
  await page.waitForTimeout(800)
  await pic(page, "workflow")

  // 4. The form of a new agent, with the starters. The window is taller, so the form fits.
  await resizeWindow(app, 1400, 1180)
  await page.getByTestId("page-chats").click()
  await page.getByTestId(`place-agent-${ada.id}`).click()
  await page.getByTestId("new-agent").click()
  await expect(page.getByTestId("new-agent-dialog")).toBeVisible()
  await page.getByTestId("starter-researcher").click()
  await page.waitForTimeout(700)
  await pic(page, "new-agent")
  await page.keyboard.press("Escape")
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
  await resizeWindow(app, 1400, 900)

  // 5. The light theme.
  await rpc(page, "settings.update", { theme: "light" })
  await page.getByTestId(`place-agent-${ada.id}`).click()
  await page.waitForTimeout(800)
  await pic(page, "chat-light")

  await app.close()
  await demo.close()
  await mock.close()
})
