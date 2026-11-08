import { mkdirSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import {
  buildFlow,
  freshUserData,
  launch,
  resizeWindow,
  shotsDir,
  startRecording,
} from "./harness.ts"
import { GOOD_KEY, startMockDecision, startMockProvider } from "./mock-provider.ts"

// The pictures of the README. This file is not a check. It starts the real app against a scripted
// stand-in model, builds one workflow, runs it, and saves one picture of each screen that the
// README shows to build/e2e/readme. It runs only when README_SHOTS is set, so the normal suite
// skips it:
//
//   README_SHOTS=1 bun run --cwd apps/desktop e2e e2e/readme-shots.spec.ts
//
// The replies in the pictures come from the script below, not from a real model.

test.skip(!process.env.README_SHOTS, "Makes the pictures of the README. Set README_SHOTS=1.")
test.setTimeout(180_000)

const outDir = join(shotsDir, "..", "readme")
const pic = async (page: Page, name: string) => {
  mkdirSync(outDir, { recursive: true })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(outDir, `${name}.png`), animations: "disabled" })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const CHANGES = [
  "Changes since 1.1:",
  "",
  "- The canvas fills the workflow view.",
  "- A text node can name a backup model.",
  "- The chat can compact a long conversation.",
].join("\n")

const NOTES = [
  "## ROBot 1.2",
  "",
  "- **Canvas.** The canvas fills the workflow view, and the node panel docks beside it.",
  "- **Backup model.** A text node can name a backup that takes over at a limit.",
  "- **Compact.** A long chat compacts into a summary, and the meter shows how full it is.",
].join("\n")

const CHAT_REPLY = [
  "The last run is done. All five nodes ran or were skipped as planned.",
  "",
  "| Node | State | Time |",
  "| --- | --- | --- |",
  "| Collect changes | Done | 2 s |",
  "| Draft notes | Done | 4 s |",
  "| Ready to publish? | Yes, 95% | 1 s |",
  "| Publish | Done after your approval | 3 s |",
  "| Fix facts | Skipped | |",
  "",
  "The notes are in the handbook. Next run: Friday at 09:00.",
].join("\n")

/** What the scripted model answers, by a part of the last message of the user. */
const scripted = (said: string): string | undefined => {
  if (said.includes("List the changes since")) return CHANGES
  if (said.includes("Write the release notes")) return NOTES
  if (said.includes("Fix the facts")) return "Fixed two links."
  if (said.includes("How did the last run go")) return CHAT_REPLY
  return undefined
}

const streamScripted = async (res: ServerResponse, text: string) => {
  res.writeHead(200, { "content-type": "text/event-stream" })
  const parts = text.match(/\S+\s*/g) ?? [text]
  for (const part of parts) {
    if (res.destroyed) return
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`)
    await sleep(12)
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
 * the pictures need with the text above, and passes every other request (tool calls, the
 * reflection after a run) on to the stand-in.
 */
const startDemoProvider = async (upstream: string) => {
  const origin = new URL(upstream).origin
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const body = JSON.parse(raw.toString("utf8") || "{}") as {
        messages?: { role: string; content: unknown }[]
      }
      const last = body.messages?.at(-1)
      const reply = last?.role === "user" ? scripted(textOf(last.content)) : undefined
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
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

const invoke = (page: Page, method: string, input?: unknown) =>
  page.evaluate(
    async ({ method, input }) => {
      const robot = (
        window as unknown as {
          robot: { invoke: (m: string, i?: unknown) => Promise<{ ok: boolean; value?: unknown }> }
        }
      ).robot
      const result = await robot.invoke(method, input)
      if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result)}`)
      return (result as { value?: unknown }).value
    },
    { method, input },
  )

const newWorkflow = async (page: Page, name: string, button: string) => {
  await page.getByTestId(button).click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("workflow-view")).toBeVisible()
}

test("README pictures", async () => {
  const mock = await startMockProvider()
  const demo = await startDemoProvider(mock.openaiUrl)
  const decision = await startMockDecision()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_DECISION_URL: decision.url,
  })
  await resizeWindow(app, 1600, 1000)
  await invoke(page, "settings.update", { decisionModel: "openrouter" })
  await invoke(page, "decision.keys", { openrouter: "sk-or-demo-key" })

  // The first workflow is the one that `buildFlow` fills.
  await newWorkflow(page, "Release notes", "new-workflow-empty")
  const flowId = await buildFlow(page, {
    provider: { openaiUrl: demo.url, key: GOOD_KEY },
    level: "ask_all",
    nodes: [
      { name: "Collect changes", prompt: "List the changes since {{trigger}}." },
      { name: "Draft notes", prompt: "Write the release notes from this list: {{input}}" },
      { name: "Ready to publish?", kind: "decision", options: ["Yes", "No"] },
      {
        name: "Publish",
        prompt: 'tool run_command {"command":"echo copied notes to the handbook"}',
      },
      { name: "Fix facts", prompt: "Fix the facts in: {{input}}" },
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3, 0],
      [2, 4, 1],
    ],
  })
  // One row of nodes, with the two branches of the decision one above the other.
  const detail = (await invoke(page, "workflows.get", { id: flowId })) as {
    graph: { nodes: { id: string }[] }
  }
  const places = [
    [24, 90],
    [240, 90],
    [456, 90],
    [680, 0],
    [680, 180],
  ]
  for (const [i, node] of detail.graph.nodes.entries()) {
    const [x, y] = places[i] ?? [0, 0]
    await invoke(page, "workflows.node.move", { id: node.id, x, y })
  }
  await newWorkflow(page, "Daily digest", "new-workflow")
  await newWorkflow(page, "Weekly report", "new-workflow")
  await page
    .getByTestId("workflow-row")
    .filter({ hasText: "Release notes" })
    .getByTestId("workflow-open")
    .click()
  await expect(page.getByTestId("graph-node")).toHaveCount(5)
  await page.getByTestId("graph-canvas").press("Escape")

  // 1. The node panel beside the canvas.
  await page.getByTestId("graph-node").nth(1).click()
  await expect(page.getByTestId("node-panel")).toBeVisible()
  await pic(page, "node-panel")
  await page.getByTestId("graph-canvas").press("Escape")

  // 2. A run, filmed: it waits for an approval, the user allows it, and the run ends.
  const stop = await startRecording(page, "readme-demo")
  await page.getByTestId("runs-trigger").fill("1.1")
  await page.getByTestId("workflow-run").click()
  const card = page.getByTestId("card-approval")
  await expect(card).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1200)
  await pic(page, "approval")
  await card.getByTestId("card-allow").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done", { timeout: 30_000 })
  await page.waitForTimeout(1500)
  await page.getByTestId("tab-graph").click()
  await page.getByTestId("chat-input").fill("How did the last run go?")
  await page.getByTestId("chat-input").press("Enter")
  await expect(page.getByTestId("message").last()).toContainText("Next run", { timeout: 30_000 })
  await page.waitForTimeout(1500)
  await stop()

  // 3. The studio: list, canvas, run strip and chat at once.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await pic(page, "studio")

  // 4. The check of the TLA form, in the run strip.
  await page.getByTestId("strip-tab-check").click()
  await expect(page.getByTestId("check-state")).toHaveText("Passed", { timeout: 30_000 })
  await pic(page, "check")

  // 5. The dark theme.
  await page.getByTestId("strip-tab-runs").click()
  await invoke(page, "settings.update", { theme: "dark" })
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await pic(page, "studio-dark")

  await app.close()
  await decision.close()
  await demo.close()
  await mock.close()
})
