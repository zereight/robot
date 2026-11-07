import { createServer } from "node:http"
import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import { buildFlow, freshUserData, launch, shot, startRunCall } from "./harness.ts"
import { GOOD_KEY, startMockDecision, startMockProvider } from "./mock-provider.ts"

// Spec 010, 005, 007, 003: the node run, its view, and the cards in the chat.

test.setTimeout(60_000)

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

const say = async (page: Page, text: string) => {
  await page.getByTestId("chat-input").fill(text)
  await page.getByTestId("chat-input").press("Enter")
}

const env = { ROBOT_SYSTEM_LOCALE: "en-US" }

test("run: two nodes, the trigger and the input go through; the run view and the chat show the result", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Weekly report")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Draft", prompt: "Hello {{trigger}}" },
      { name: "Edit", prompt: "Summarize: {{input}}" },
    ],
    edges: [[0, 1]],
  })

  await page.getByTestId("tab-runs").click()
  await expect(page.getByTestId("runs-none")).toBeVisible()
  await page.getByTestId("runs-trigger").fill("world")
  await page.getByTestId("workflow-run").click()

  // The run view opens at once and follows the run.
  await expect(page.getByTestId("run-view")).toBeVisible()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-state-1")).toHaveText("Done")
  await expect(page.getByTestId("run-node-state-2")).toHaveText("Done")
  await expect(page.getByTestId("run-node-result-1")).toHaveText("You said: Hello world")
  await expect(page.getByTestId("run-node-result-2")).toHaveText(
    "You said: Summarize: You said: Hello world",
  )
  await expect(page.getByTestId("workflow-stop")).toHaveCount(0)
  await shot(page, "w6-01-run-view")

  // The run list shows the run with its state and how far it went.
  await page.getByTestId("run-back").click()
  await expect(page.getByTestId("runs-list").locator("li")).toHaveCount(1)
  await expect(page.getByTestId("runs-list")).toContainText("Done")
  await expect(page.getByTestId("runs-list")).toContainText("2 of 2 nodes")
  await shot(page, "w6-02-run-list")

  // The chat reads the same facts: its answer holds the result of the last node.
  await say(page, "How did the run go?")
  await expect(page.getByTestId("message").last()).toContainText("You said: How did the run go?")
  const prompt = String(mock.requests.at(-1)?.body.messages[0]?.content)
  expect(prompt).toContain("You said: Summarize: You said: Hello world")
  expect(prompt).toContain('Node 2 "Edit" (text): done')
  await app.close()
  await mock.close()
})

test("run: a decision node takes the branch; with no winner the chat asks for a pick", async () => {
  const mock = await startMockProvider()
  const decision = await startMockDecision()
  const { app, page } = await launch(undefined, {
    ...env,
    ROBOT_TEST_DECISION_URL: decision.url,
  })
  await newWorkflow(page, "Branches")
  await page.evaluate(async () => {
    const invoke = (
      window as unknown as { robot: { invoke: (m: string, i?: unknown) => Promise<unknown> } }
    ).robot.invoke
    await invoke("settings.update", { decisionModel: "openrouter" })
    await invoke("decision.keys", { openrouter: "sk-or-test-key" })
  })
  const workflowId = await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Choose", kind: "decision", options: ["Yes", "No"] },
      { name: "Yes path", prompt: "yes path" },
      { name: "No path", prompt: "no path" },
    ],
    edges: [
      [0, 1, 0],
      [0, 2, 1],
    ],
  })
  await page.getByTestId("tab-runs").click()

  // A clear winner: the node takes "Yes", the other branch is skipped.
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-state-1")).toHaveText("Done")
  await expect(page.getByTestId("run-node-decision-1")).toContainText("Yes 95%")
  await expect(page.getByTestId("run-node-decision-1")).toContainText("Option taken: Yes")
  await expect(page.getByTestId("run-node-state-2")).toHaveText("Done")
  await expect(page.getByTestId("run-node-state-3")).toHaveText("Skipped")
  await shot(page, "w6-03-decision-branch")
  await page.getByTestId("run-back").click()

  // No option reaches the threshold: a pick card waits in the chat.
  decision.set([0.6, 0.4])
  await startRunCall(page, workflowId)
  const card = page.getByTestId("card-pick")
  await expect(card).toBeVisible()
  await expect(card).toContainText("No option reached 0.9.")
  await shot(page, "w6-04-pick-card")
  await card.getByTestId("card-pick-No").click()
  await expect(page.getByTestId("card-pick")).toHaveCount(0)
  await expect(page.getByTestId("card-answered")).toContainText("Picked: No")
  await page.getByTestId("runs-list").locator("button").first().click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-state-2")).toHaveText("Skipped")
  await expect(page.getByTestId("run-node-state-3")).toHaveText("Done")
  await app.close()
  await mock.close()
  await decision.close()
})

test("run: Stop cancels the run and keeps the part result", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Stoppable")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Slow", prompt: "slow work" },
      { name: "After", prompt: "after {{input}}" },
    ],
    edges: [[0, 1]],
  })
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText("Running")
  await expect(page.getByTestId("run-node-result-1")).toContainText("word2")
  await page.getByTestId("workflow-stop").click()
  await expect(page.getByTestId("run-state")).toHaveText("Cancelled")
  await expect(page.getByTestId("run-node-state-1")).toHaveText("Cancelled")
  await expect(page.getByTestId("run-node-state-2")).toHaveText("Not reached")
  await expect(page.getByTestId("run-node-reason-1")).toContainText("Stopped by you")
  await expect(page.getByTestId("run-node-result-1")).toContainText("word1")
  await expect(page.getByTestId("workflow-stop")).toHaveCount(0)
  await shot(page, "w6-05-run-stopped")
  await app.close()
  await mock.close()
})

test("run: a model call is tried again; a node that fails 3 times stops the run", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Retry")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Flaky", prompt: "[[flaky]] first" },
      { name: "Broken", prompt: "[[fail]] second" },
      { name: "Last", prompt: "last" },
    ],
    edges: [
      [0, 1],
      [1, 2],
    ],
  })
  const before = mock.requests.length
  await page.getByTestId("workflow-run").click()
  // 2 s between the tries, so the whole run takes about 8 s.
  await expect(page.getByTestId("run-state")).toHaveText("Failed", { timeout: 30_000 })
  await expect(page.getByTestId("run-node-state-1")).toHaveText("Done")
  await expect(page.getByTestId("run-node-state-2")).toHaveText("Failed")
  await expect(page.getByTestId("run-node-state-3")).toHaveText("Not reached")
  await expect(page.getByTestId("run-node-reason-2")).toBeVisible()
  // 6 requests of the nodes, then 1 request of the reflection after the run (spec 002).
  await expect.poll(() => mock.requests.length - before).toBe(7)
  await shot(page, "w6-06-run-failed")
  await app.close()
  await mock.close()
})

test("run: a step that needs approval waits on a card; Allow runs it and Deny refuses it", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Approvals")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    level: "ask_all",
    nodes: [{ name: "Shell", prompt: 'tool run_command {"command":"echo card-ok"}' }],
  })
  await page.getByTestId("tab-runs").click()

  // Allow
  await page.getByTestId("workflow-run").click()
  const card = page.getByTestId("card-approval")
  await expect(card).toBeVisible()
  await expect(card.getByTestId("card-summary")).toHaveText("echo card-ok")
  await expect(card).toContainText("Command")
  await expect(card).toContainText("Node 1 “Shell”")
  // A screen reader hears the card: it is an alert, and its long text can take the focus.
  await expect(card).toHaveAttribute("role", "alert")
  await expect(card.getByTestId("card-summary")).toHaveAttribute("tabindex", "0")
  await expect(page.getByTestId("run-state")).toHaveText("Waiting for you")
  await expect(page.getByTestId("run-node-reason-1")).toContainText("Waits for your approval")
  await shot(page, "w6-07-approval-card")
  await card.getByTestId("card-allow").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-result-1")).toContainText("card-ok")
  await expect(page.getByTestId("card-answered")).toContainText("Allowed")
  await page.getByTestId("run-back").click()

  // Deny
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("card-approval")).toBeVisible()
  await page.getByTestId("card-approval").getByTestId("card-deny").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-result-1")).not.toContainText("card-ok")
  await expect(page.getByTestId("card-answered").last()).toContainText("Denied")
  await app.close()
  await mock.close()
})

test("run: feedback in the chat reaches the next text node, not the node that has started", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await newWorkflow(page, "Feedback")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    level: "full",
    nodes: [
      { name: "First", prompt: 'tool run_command {"command":"sleep 3"}' },
      { name: "Second", prompt: "Second: {{input}}" },
    ],
    edges: [[0, 1]],
  })
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-node-state-1")).toHaveText("Running")
  await say(page, 'tool add_run_feedback {"text":"Use fewer words"}')
  await expect(page.getByTestId("tool-card")).toContainText("Added feedback to the run")
  await expect(page.getByTestId("run-state")).toHaveText("Done", { timeout: 30_000 })
  await expect(page.getByTestId("run-feedback")).toContainText("Use fewer words")
  await expect(page.getByTestId("run-feedback")).toContainText("Goes to node 2")
  // The entry shows its time.
  await expect(page.getByTestId("run-feedback").locator("time")).toHaveAttribute("datetime", /Z$/)
  await expect(page.getByTestId("run-node-input-2")).toContainText("Use fewer words")
  await expect(page.getByTestId("run-node-input-1")).toHaveCount(0)
  await expect(page.getByTestId("run-node-result-2")).toContainText("Use fewer words")
  await shot(page, "w6-08-run-feedback")
  await app.close()
  await mock.close()
})

test("run: after an app restart a waiting task fails with 'The app stopped' and its card is gone", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  let { app, page } = await launch(userData, env)
  await newWorkflow(page, "Restart")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    level: "ask_all",
    nodes: [{ name: "Shell", prompt: 'tool run_command {"command":"echo never"}' }],
  })
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("card-approval")).toBeVisible()
  await app.close()

  ;({ app, page } = await launch(userData, env))
  await expect(page.getByTestId("chat")).toBeVisible()
  await expect(page.getByTestId("card-approval")).toHaveCount(0)
  await page.getByTestId("tab-runs").click()
  await expect(page.getByTestId("runs-list")).toContainText("Failed")
  await page.getByTestId("runs-list").locator("button").first().click()
  await expect(page.getByTestId("run-state")).toHaveText("Failed")
  await expect(page.getByTestId("run-reason")).toContainText("The app stopped")
  await expect(page.getByTestId("run-node-reason-1")).toContainText("The app stopped")
  await expect(page.getByTestId("workflow-stop")).toHaveCount(0)
  await shot(page, "w6-09-run-after-restart")
  await app.close()
  await mock.close()
})

test("run: a task that read a page shows the outside mark, in English and in Korean", async () => {
  for (const locale of ["en-US", "ko-KR"] as const) await markLine(locale)
})

const markLine = async (locale: "en-US" | "ko-KR") => {
  const mock = await startMockProvider()
  const server = createServer((_req, res) => res.end("page text")).listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const port = (server.address() as { port: number }).port
  const { app, page } = await launch(undefined, { ROBOT_SYSTEM_LOCALE: locale })
  await newWorkflow(page, "Marks")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    level: "full",
    nodes: [
      { name: "Reader", prompt: `tool fetch_url {"url":"http://127.0.0.1:${port}/"}` },
      { name: "Plain", prompt: "Plain" },
    ],
  })
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText(locale === "en-US" ? "Done" : "완료")
  // The task that fetched the page holds outside content, with the host. The other holds none.
  await expect(page.getByTestId("run-node-outside-1")).toContainText(
    locale === "en-US"
      ? "Holds outside content: the web page 127.0.0.1"
      : "외부 내용을 갖고 있어요: 웹 페이지 127.0.0.1",
  )
  await expect(page.getByTestId("run-node-marks-2")).toHaveCount(0)
  await shot(page, locale === "en-US" ? "w6-10-run-mark-line" : "w6-10-run-mark-line-ko")
  await app.close()
  server.close()
  await mock.close()
}

test("run: a node at Read only on a program with no read-only mode shows words, not a code", async () => {
  const mock = await startMockProvider()
  const fake = makeFakeRuntimes()
  const { app, page } = await launch(undefined, { ...env, ROBOT_OPENCODE_BIN: fake.opencode })
  await newWorkflow(page, "No mode")
  await page.evaluate(async () => {
    const invoke = (
      window as unknown as { robot: { invoke: (m: string, i?: unknown) => Promise<unknown> } }
    ).robot.invoke
    await invoke("providers.connect", { kind: "opencode", name: "Open" })
  })
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [{ name: "Reader", prompt: "hi" }],
  })
  // The node uses the program account and the level Read only.
  await page.evaluate(async () => {
    type Invoke = (m: string, i?: unknown) => Promise<{ value?: unknown }>
    const invoke = (window as unknown as { robot: { invoke: Invoke } }).robot.invoke
    const servers = ((await invoke("servers.list")).value ?? []) as { id: string; kind: string }[]
    const local = servers.find((x) => x.kind === "local")
    const flows = ((await invoke("workflows.list", { serverId: local?.id })).value ?? []) as {
      id: string
    }[]
    const accounts = ((await invoke("providers.list")).value ?? []) as {
      id: string
      kind: string
    }[]
    const detail = (await invoke("workflows.get", { id: flows[0]?.id })).value as {
      graph: { nodes: { id: string }[] }
    }
    await invoke("workflows.node.update", {
      id: detail.graph.nodes[0]?.id,
      patch: {
        accountId: accounts.find((a) => a.kind === "opencode")?.id,
        model: "default",
        permission: "read_only",
      },
    })
  })
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText("Failed")
  const reason = page.getByTestId("run-node-reason-1")
  await expect(reason).toContainText("Read only")
  await expect(reason).not.toContainText("read_only_unsupported")
  await shot(page, "w6-11-run-failure-words")
  await app.close()
  await mock.close()
})
