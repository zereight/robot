import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot, startRunCall } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 018 (connections for the text nodes of workflows), with 007 (cards, levels, rules): a
// connection in scope is used by a node, a connection out of scope is not, the card shows at the
// permission levels, and "Always allow for this workflow" saves a rule. The test program is the
// small MCP server in fakes/mcp-server.mjs.

test.setTimeout(120_000)

const SERVER = resolve(import.meta.dirname, "fakes/mcp-server.mjs")

type Invoke = (method: string, input?: unknown) => Promise<{ ok: boolean; value?: unknown }>

const invokeCall = <T>(page: Page, method: string, input?: unknown) =>
  page.evaluate(
    async ({ method, input }) => {
      const invoke = (window as unknown as { robot: { invoke: Invoke } }).robot.invoke
      const result = await invoke(method, input)
      if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result)}`)
      return result.value
    },
    { method, input },
  ) as Promise<T>

/** Makes the account and the workflows, with one text node each. */
const makeFlows = async (page: Page, openaiUrl: string, flows: [string, string][]) => {
  const servers = await invokeCall<{ id: string; kind: string }[]>(page, "servers.list")
  const serverId = servers.find((s) => s.kind === "local")?.id
  await invokeCall(page, "providers.connect", {
    kind: "openai",
    name: "Mock",
    baseUrl: openaiUrl,
    apiKey: GOOD_KEY,
  })
  const account = (await invokeCall<{ id: string }[]>(page, "providers.list"))[0]
  const ids: Record<string, string> = {}
  for (const [name, prompt] of flows) {
    const flow = await invokeCall<{ id: string }>(page, "workflows.create", { serverId, name })
    await invokeCall(page, "workflows.node.add", {
      workflowId: flow.id,
      node: {
        kind: "text",
        name: "Use notes",
        prompt,
        accountId: account?.id,
        model: "mock-fast",
        x: 24,
        y: 24,
      },
    })
    ids[name] = flow.id
  }
  return ids
}

const openWorkflow = async (page: Page, name: string) => {
  await page
    .getByTestId("workflow-row")
    .filter({ hasText: name })
    .getByTestId("workflow-open")
    .click()
  await expect(page.getByTestId("workflow-view")).toBeVisible()
}

/** Opens a workflow and starts a run in it. The cards of its tasks show in its chat. */
const startIn = async (page: Page, name: string, workflowId: string) => {
  await openWorkflow(page, name)
  return await startRunCall(page, workflowId)
}

/** Opens the newest run of the open workflow in its runs tab. */
const viewNewestRun = async (page: Page) => {
  if (await page.getByTestId("run-back").count()) await page.getByTestId("run-back").click()
  await page.getByTestId("runs-list").locator("button").first().click()
  await expect(page.getByTestId("run-view")).toBeVisible()
}

const callsIn = (file: string): { tool: string; args: unknown }[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

const toolsOfLastRequest = (mock: Awaited<ReturnType<typeof startMockProvider>>) =>
  (mock.requests.at(-1)?.body.tools ?? []).map((t) => t.function.name)

const rowOf = (page: Page) => page.locator('[data-testid=connection-row][data-connection="Notes"]')

test("connections: scope per workflow, the card at the permission levels, Always allow for this workflow", async () => {
  const mock = await startMockProvider()
  const calls = join(mkdtempSync(join(tmpdir(), "robot-b10-")), "calls.jsonl")
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)
  await page.getByTestId("new-workflow-empty").waitFor()
  const ids = await makeFlows(page, mock.openaiUrl, [
    ["Weekly report", 'tool mcp__notes__echo {"text":"from A"}'],
    ["Outside", 'tool mcp__notes__echo {"text":"from B"}'],
    ["Lookup", 'tool mcp__notes__lookup {"word":"cat"}'],
  ])
  const weekly = ids["Weekly report"] ?? ""
  const outside = ids.Outside ?? ""
  const lookup = ids.Lookup ?? ""

  // Add the connection in the form: a program on this computer, for two of the three workflows.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-connections").click()
  await expect(page.getByTestId("connections-section")).toBeVisible()
  await page.getByTestId("connection-add").click()
  await expect(page.getByTestId("connection-form")).toBeVisible()
  await page.getByTestId("connection-name").fill("Notes")
  await page.getByTestId("connection-command").fill(process.execPath)
  await page.getByTestId("connection-args").fill(SERVER)
  await page.getByTestId("connection-env-add").click()
  const line = page.getByTestId("connection-env-line").first()
  await line.getByTestId("connection-env-name").fill("MCP_TEST_CALLS")
  await line.getByTestId("connection-env-value").fill(calls)
  // A new connection is for all workflows. The user picks a list.
  await expect(page.getByTestId("connection-scope-kind")).toContainText("All workflows")
  await page.getByTestId("connection-scope-kind").getByText("Chosen workflows").click()
  await expect(page.getByTestId("connection-scope-list")).toBeVisible()
  for (const name of ["Weekly report", "Lookup"])
    await page.locator(`[data-testid=connection-scope-workflow][data-workflow="${name}"]`).check()
  await page.getByTestId("connection-test").click()
  await expect(page.getByTestId("connection-test-result")).toContainText("Tools:")
  await page.getByTestId("connection-confirm").check()
  await shot(page, "b10-01-form-scope")
  await page.getByTestId("connection-save").click()
  await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
  await expect(rowOf(page).getByTestId("connection-row-scope")).toHaveText(
    "Workflows: Lookup, Weekly report",
  )
  await shot(page, "b10-02-row-scope")
  await page.getByTestId("settings-close").click()

  // A text node of "Weekly report" calls the tool at "Ask for risky steps": a card asks.
  const first = await startIn(page, "Weekly report", weekly)
  const card = page.getByTestId("card-approval")
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId("card-summary")).toContainText("Notes · echo")
  await expect(page.getByTestId("card-summary")).toContainText('"text": "from A"')
  await shot(page, "b10-03-card")
  await page.getByTestId("card-always").click()
  await expect(card).toHaveCount(0)
  expect(first).not.toBe("")
  await viewNewestRun(page)
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-tool-line")).toHaveText("Notes · echo: Ran — Allowed by you")
  await expect(page.getByTestId("run-node-result-1")).toContainText("Tool said: Echo: from A")
  await expect(page.getByTestId("run-node-outside-1")).toBeVisible()
  await shot(page, "b10-04-tool-line")

  // The rules page shows one Allow rule for that tool, for that workflow.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  await expect(page.getByTestId("rule-row")).toHaveCount(1)
  await expect(page.getByTestId("rule-row")).toContainText("Notes")
  await expect(page.getByTestId("rule-row")).toContainText("echo")
  await expect(page.getByTestId("rule-workflow")).toContainText("Weekly report")
  await expect(page.getByTestId("rule-tag")).toContainText("Allow")
  await shot(page, "b10-05-rule")
  await page.getByTestId("settings-close").click()

  // A second call runs with no question, and the log has two entries.
  await startIn(page, "Weekly report", weekly)
  await expect.poll(() => callsIn(calls).length, { timeout: 20_000 }).toBe(2)
  await expect(page.getByTestId("card-approval")).toHaveCount(0)
  await viewNewestRun(page)
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-tool-line")).toHaveText(
    "Notes · echo: Ran — Allowed by a rule",
  )
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  const logEntries = page.getByTestId("action-log-entry").filter({ hasText: "Notes" })
  await expect(logEntries).toHaveCount(2)
  await page.getByTestId("settings-close").click()

  // A workflow out of scope gets no tool: it calls the name, the step fails, the connection gets
  // no call, and no card shows.
  await startIn(page, "Outside", outside)
  await viewNewestRun(page)
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-result-1")).toContainText(
    "Unknown tool: mcp__notes__echo",
  )
  expect(toolsOfLastRequest(mock).some((n) => n.startsWith("mcp__"))).toBe(false)
  expect(callsIn(calls)).toHaveLength(2)

  // The other levels, on the workflow "Lookup" (the tool "lookup" has the read-only mark).
  const setLevel = (id: string, level: string) =>
    invokeCall(page, "workflows.setPermission", { id, level })
  await setLevel(lookup, "read_only")
  await startIn(page, "Lookup", lookup)
  await viewNewestRun(page)
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-tool-line")).toHaveText(
    "Notes · lookup: Refused — Permission level: Read only",
  )
  expect(callsIn(calls)).toHaveLength(2)

  // Trust read-only marks: on, the marked tool runs with no card at "Ask for risky steps" and the
  // line says so. At "Ask for everything" it still asks.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-connections").click()
  await rowOf(page).getByTestId("connection-trust-switch").check()
  await page.getByTestId("settings-close").click()
  await setLevel(lookup, "ask_risky")
  await startIn(page, "Lookup", lookup)
  await expect.poll(() => callsIn(calls).length, { timeout: 20_000 }).toBe(3)
  await viewNewestRun(page)
  await expect(page.getByTestId("run-tool-line")).toHaveText(
    "Notes · lookup: Ran — Read only, as the connection says",
  )
  await setLevel(lookup, "ask_all")
  await startIn(page, "Lookup", lookup)
  await expect(page.getByTestId("card-approval")).toBeVisible({ timeout: 20_000 })
  await page.getByTestId("card-allow").click()
  await expect.poll(() => callsIn(calls).length, { timeout: 20_000 }).toBe(4)

  // A Deny rule for any tool of the connection wins, also at Full access: the card is not shown,
  // the call is refused.
  await invokeCall(page, "rules.add", {
    workflowId: null,
    kind: "connection",
    text: "Notes",
    detail: null,
    decision: "deny",
  })
  await setLevel(lookup, "full")
  await startIn(page, "Lookup", lookup)
  await viewNewestRun(page)
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-tool-line")).toHaveText(
    "Notes · lookup: Refused — Denied by a rule",
  )
  await expect(page.getByTestId("card-approval")).toHaveCount(0)
  expect(callsIn(calls)).toHaveLength(4)

  // The words in Korean.
  await invokeCall(page, "settings.update", { language: "ko" })
  await openWorkflow(page, "Lookup")
  await viewNewestRun(page)
  await expect(page.getByTestId("run-tool-line")).toContainText("규칙으로 거부됨")
  await shot(page, "b10-06-tool-line-ko")
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-connections").click()
  await expect(rowOf(page).getByTestId("connection-row-scope")).toContainText("워크플로우:")
  await rowOf(page).getByTestId("connection-edit").click()
  await expect(page.getByTestId("connection-scope-kind")).toContainText("고른 워크플로우")
  await shot(page, "b10-07-form-scope-ko")
  await page.getByTestId("connection-cancel").click()
  await page.getByTestId("settings-close").click()
  await invokeCall(page, "settings.update", { language: "en" })

  // Delete the workflows of the list: the row says that no workflow uses the connection.
  await invokeCall(page, "workflows.delete", { id: weekly })
  await invokeCall(page, "workflows.delete", { id: lookup })
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-connections").click()
  await expect(rowOf(page).getByTestId("connection-row-scope")).toHaveText(
    "No workflow uses this connection.",
  )
  await shot(page, "b10-08-no-workflow")
  await app.close()
  await mock.close()
})

test("connections: a value that looks like a secret is hidden, the card says so and has no Always allow; invisible characters show as escapes", async () => {
  const mock = await startMockProvider()
  const calls = join(mkdtempSync(join(tmpdir(), "robot-b10-")), "calls.jsonl")
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)
  await page.getByTestId("new-workflow-empty").waitFor()
  const secret = `sk-${Buffer.from("owner password is hunter2").toString("base64url")}`
  const ids = await makeFlows(page, mock.openaiUrl, [
    ["Secret", `tool mcp__notes__echo {"text":"${secret}"}`],
    ["Tags", 'tool mcp__notes__echo {"text":"hello\\udb40\\udc68\\u202e"}'],
  ])
  const connection = {
    name: "Notes",
    kind: "program",
    command: process.execPath,
    args: [SERVER],
    folder: "",
    env: [{ name: "MCP_TEST_CALLS", value: calls, secret: false }],
    address: "",
    headers: [],
  }
  await invokeCall(page, "connections.test", { connection })
  await invokeCall(page, "connections.save", { connection, confirmed: true })
  // Even when the user allowed this tool for the workflow, a hidden value asks.
  await invokeCall(page, "rules.add", {
    workflowId: ids.Secret,
    kind: "connection",
    text: "Notes",
    detail: "echo",
    decision: "allow",
  })

  await startIn(page, "Secret", ids.Secret ?? "")
  await expect(page.getByTestId("card-approval")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId("card-summary")).toContainText("[redacted]")
  await expect(page.getByTestId("card-summary")).not.toContainText(secret)
  await expect(page.getByTestId("card-hidden")).toHaveText(
    "Values hidden because they look like a secret: 1. The call sends them in full, and you cannot check them here.",
  )
  await expect(page.getByTestId("card-always")).toHaveCount(0)
  await shot(page, "b10-09-card-hidden")
  await invokeCall(page, "settings.update", { language: "ko" })
  await expect(page.getByTestId("card-hidden")).toContainText("비밀처럼 보여서 가린 값: 1개")
  await shot(page, "b10-10-card-hidden-ko")
  await invokeCall(page, "settings.update", { language: "en" })
  await page.getByTestId("card-allow").click()
  await expect.poll(() => callsIn(calls).length, { timeout: 20_000 }).toBe(1)
  expect(JSON.stringify(callsIn(calls)[0])).toContain(secret)

  await startIn(page, "Tags", ids.Tags ?? "")
  await expect(page.getByTestId("card-approval")).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId("card-summary")).toContainText('"text": "hello\\u{e0068}\\u202e"')
  await expect(page.getByTestId("card-hidden")).toHaveCount(0)
  await expect(page.getByTestId("card-always")).toBeVisible()
  await shot(page, "b10-11-card-escapes")
  await page.getByTestId("card-deny").click()
  await app.close()
  await mock.close()
})
