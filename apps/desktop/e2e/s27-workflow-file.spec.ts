import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const center = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error("no box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Drags from a handle of one node to the body of another. A real mouse drag can miss on a slow
 * runner, so the drag is tried again until the number of edges grows.
 */
const connect = async (page: Page, from: number, to: number, handle = "wf-handle-out") => {
  const nodes = page.getByTestId("wf-node")
  const edges = page.getByTestId("wf-edge")
  const count = await edges.count()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const start = await center(nodes.nth(from).getByTestId(handle))
    const end = await center(nodes.nth(to))
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 })
    await page.mouse.move(end.x, end.y, { steps: 4 })
    await page.mouse.up()
    if (attempt === 3) break
    try {
      await expect(edges).toHaveCount(count + 1, { timeout: 1500 })
      return
    } catch {
      // Try the drag again.
    }
  }
  await expect(edges).toHaveCount(count + 1)
}

/** A reply of the mock is "Hello! You said: " and the prompt. This prompt makes it longer than 200. */
const PROMPT = `Say Hello to the team. ${"filler ".repeat(45).trim()}`

const openWorkflows = async (page: Page) => {
  await page.getByTestId("page-workflows").click()
}

interface Notice {
  title: string
  body: string
}

const readNotices = (log: string): Notice[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Notice)
    : []

test("workflow file: export, import with the agent, notify step with the whole input", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s27-"))
  const workflowFile = join(work, "workflows.json")
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }

  // App one: a workflow with an agent step, a condition that asks a model, two notify steps and a note.
  let { app, page } = await launch(freshUserData(), {
    ...env,
    ROBOT_TEST_WORKFLOW_FILE_SAVE: workflowFile,
  })
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await openWorkflows(page)
  await page.getByTestId("wf-new").click()
  await page.getByTestId("wf-name").fill("Greeting check")

  await page.getByTestId("wf-add-agent").click()
  await page.getByTestId("wf-step-name").fill("Draft")
  await page.getByTestId("wf-step-prompt").fill(PROMPT)
  await page.getByTestId("wf-step-effort").selectOption("low")
  await page.getByTestId("wf-add-condition").click()
  await page.getByTestId("wf-step-name").fill("Greeting?")
  await page.getByTestId("wf-step-mode").selectOption("ask")
  await page.getByTestId("wf-step-contains").fill("Is the text a greeting?")
  await page.getByTestId("wf-add-notify").click()
  await page.getByTestId("wf-step-name").fill("Tell yes")
  await page.getByTestId("wf-step-title").fill("Greeting found")
  await page.getByTestId("wf-add-notify").click()
  await page.getByTestId("wf-step-name").fill("Tell no")
  await page.getByTestId("wf-step-title").fill("No greeting")
  await expect(page.getByTestId("wf-node")).toHaveCount(4)

  await connect(page, 0, 1)
  await connect(page, 1, 2, "wf-handle-yes")
  await connect(page, 1, 3, "wf-handle-no")
  await expect(page.getByTestId("wf-edge")).toHaveCount(3)

  // A note has no number and no connection.
  await page.getByTestId("wf-add-note").click()
  await page.getByTestId("wf-note-text").fill("The question needs a model")
  await page.getByTestId("wf-note-tone").selectOption("blue")
  await expect(page.getByTestId("wf-note")).toHaveCount(1)
  await expect(page.getByTestId("wf-node-number")).toHaveText(["1", "2", "3", "4"])
  await page.getByTestId("wf-save").click()
  await expect(page.getByTestId("toast-success")).toHaveText("Workflow saved.")
  await shot(page, "s27-01-source")
  await page.getByTestId("wf-back").click()
  await expect(page.getByTestId("wf-card")).toHaveCount(1)

  // The menu of the Workflows page closes on Escape and gives the focus back.
  await page.getByTestId("wf-menu").click()
  await expect(page.getByTestId("wf-menu-export")).toBeFocused()
  await shot(page, "s27-02-menu")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("wf-menu-export")).toHaveCount(0)
  await expect(page.getByTestId("wf-menu")).toBeFocused()

  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-export").click()
  await expect(page.getByTestId("workflow-export-item")).toHaveCount(1)
  await shot(page, "s27-03-export")
  await page.getByTestId("workflow-export-submit").click()
  await expect(page.getByTestId("workflow-export-saved")).toContainText(workflowFile)
  await page.getByTestId("workflow-export-close").click()
  await expect(page.getByTestId("workflow-export-dialog")).toHaveCount(0)
  await app.close()

  // The file holds the workflow, with the agent by name, and nothing of the app.
  const text = readFileSync(workflowFile, "utf8")
  const written = JSON.parse(text) as {
    format: string
    version: number
    workflows: {
      name: string
      trigger: unknown
      steps: Record<string, unknown>[]
      connections: unknown[]
      notes: Record<string, unknown>[]
    }[]
  }
  expect(written).toMatchObject({ format: "robot-workflows", version: 1 })
  expect(written.workflows).toHaveLength(1)
  const [workflow] = written.workflows
  expect(workflow?.name).toBe("Greeting check")
  expect(workflow?.trigger).toEqual({ kind: "manual" })
  expect(workflow?.steps.map((s) => [s.kind, s.name])).toEqual([
    ["agent", "Draft"],
    ["condition", "Greeting?"],
    ["notify", "Tell yes"],
    ["notify", "Tell no"],
  ])
  expect(workflow?.steps[0]).toMatchObject({ agent: "Ada", prompt: PROMPT, effort: "low" })
  expect(workflow?.steps[1]).toMatchObject({ mode: "ask", text: "Is the text a greeting?" })
  expect(workflow?.connections).toEqual([
    { from: 1, to: 2 },
    { from: 2, to: 3, branch: "yes" },
    { from: 2, to: 4, branch: "no" },
  ])
  expect(workflow?.notes).toMatchObject([{ text: "The question needs a model", tone: "blue" }])
  for (const absent of [GOOD_KEY, "mock-fast", "channelId", "agentId", "enabled"])
    expect(text).not.toContain(absent)

  // App two has an agent of the same name. The import links the step to that agent.
  const userData = freshUserData()
  const log = join(userData, "notices.jsonl")
  ;({ app, page } = await launch(userData, {
    ...env,
    ROBOT_TEST_WORKFLOW_FILE_OPEN: workflowFile,
    ROBOT_TEST_NOTIFY_LOG: log,
    ROBOT_TEST_UNFOCUSED: "1",
  }))
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await openWorkflows(page)
  await expect(page.getByTestId("wf-list-empty")).toBeVisible()
  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-import-file").click()
  const dialog = page.getByTestId("workflow-import-dialog")
  await expect(dialog.getByTestId("workflow-import-item")).toHaveCount(1)
  await expect(dialog).toContainText("Greeting check")
  await expect(dialog).toContainText("4 steps, 1 notes")
  await expect(dialog.getByTestId("workflow-import-missing")).toHaveCount(0)
  await expect(dialog).toContainText("Every imported workflow is off.")
  await shot(page, "s27-04-import")
  await dialog.getByTestId("workflow-import-submit").click()
  await expect(dialog).toHaveCount(0)

  // The workflow exists and is off. It has the same steps, numbers and note.
  await expect(page.getByTestId("wf-card")).toHaveCount(1)
  await expect(page.getByTestId("wf-card")).toContainText("Greeting check")
  await expect(page.getByTestId("wf-card")).toContainText("Off")
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-node")).toHaveCount(4)
  await expect(page.getByTestId("wf-node-number")).toHaveText(["1", "2", "3", "4"])
  await expect(page.getByTestId("wf-node")).toContainText([
    "Draft",
    "Greeting?",
    "Tell yes",
    "Tell no",
  ])
  await expect(page.getByTestId("wf-edge")).toHaveCount(3)
  await expect(page.getByTestId("wf-note")).toHaveCount(1)
  await expect(page.getByTestId("wf-note")).toContainText("The question needs a model")
  await expect(page.getByTestId("wf-node").first()).not.toContainText("Pick an agent")
  await page.getByTestId("wf-node").first().click()
  await expect(page.getByTestId("wf-step-agent").locator("option:checked")).toHaveText("Ada")
  await expect(page.getByTestId("wf-step-effort")).toHaveValue("low")
  await page.getByTestId("wf-node").nth(1).click()
  await expect(page.getByTestId("wf-step-mode")).toHaveValue("ask")
  await expect(page.getByTestId("wf-step-contains")).toHaveValue("Is the text a greeting?")
  await shot(page, "s27-05-imported")

  // Run it with the window hidden: the model says yes, and the notify step shows its title.
  await page.getByTestId("wf-run").click()
  await expect(page.getByTestId("wf-run-row")).toContainText("Done", { timeout: 30_000 })
  // The agent step also notifies, as any reply of an agent does while the window is hidden.
  const ofStep = () => readNotices(log).filter((n) => n.title === "Greeting found")
  await expect.poll(() => ofStep().length, { timeout: 10_000 }).toBe(1)
  expect(readNotices(log).filter((n) => n.title === "No greeting")).toHaveLength(0)
  const [notice] = ofStep()
  // The body is the first 200 characters of the input; the run view holds the whole input.
  expect(notice?.body).toHaveLength(200)
  expect(notice?.body.startsWith("Hello! You said: Say Hello to the team.")).toBe(true)
  const steps = page.getByTestId("wf-run-step")
  await expect(steps).toHaveCount(4)
  await steps.nth(2).locator("summary").click()
  const input = (await steps.nth(2).getByTestId("wf-step-input").textContent()) ?? ""
  expect(input.length).toBeGreaterThan(200)
  expect(input.startsWith(notice?.body ?? "?")).toBe(true)
  expect(input.endsWith("filler")).toBe(true)
  // The step passes its input on unchanged, and the branch that did not run is skipped.
  await expect(steps.nth(3)).toHaveAttribute("data-state", "skipped")
  await shot(page, "s27-06-notify-run")
  await app.close()
  await mock.close()
})

test("workflow file: import into an app without the agent", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s27-"))
  const workflowFile = join(work, "hand-written.json")
  // A file that another tool could write: plain keys, a notify step and an agent that does not exist.
  const file = {
    format: "robot-workflows",
    version: 1,
    workflows: [
      {
        name: "Ask Zed",
        steps: [
          { kind: "agent", name: "Zed works", agent: "Zed", prompt: "Say hi", x: 0, y: 0 },
          { kind: "notify", name: "Share", title: "{{input}}", x: 260, y: 0 },
        ],
        connections: [{ from: 1, to: 2 }],
      },
    ],
  }
  writeFileSync(workflowFile, JSON.stringify(file))

  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_WORKFLOW_FILE_OPEN: workflowFile,
  })
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await openWorkflows(page)
  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-import-file").click()
  const dialog = page.getByTestId("workflow-import-dialog")
  await expect(dialog.getByTestId("workflow-import-item")).toHaveCount(1)
  // The list names the agent that the app cannot find.
  await expect(dialog.getByTestId("workflow-import-missing")).toHaveText("Agents not found: Zed")
  await shot(page, "s27-07-import-missing")
  await dialog.getByTestId("workflow-import-submit").click()
  await expect(dialog).toHaveCount(0)

  // The agent step shows "Pick an agent". No agent is made.
  await page.getByTestId("wf-open").click()
  await expect(page.getByTestId("wf-node")).toHaveCount(2)
  await expect(page.getByTestId("wf-node").first()).toContainText("Pick an agent")
  await page.getByTestId("wf-node").first().click()
  await expect(page.getByTestId("wf-step-agent")).toHaveValue("")
  await shot(page, "s27-08-pick-an-agent")

  // A run fails at the first step with the reason "No agent".
  await page.getByTestId("wf-run").click()
  await expect(page.getByTestId("wf-run-row")).toContainText("Failed", { timeout: 30_000 })
  const steps = page.getByTestId("wf-run-step")
  await steps.first().locator("summary").click()
  await expect(steps.first().getByTestId("wf-step-error")).toContainText("No agent")
  await app.close()

  // A file with a graph fault is refused as a whole, and the dialog names the workflow and the place.
  writeFileSync(
    workflowFile,
    JSON.stringify({
      format: "robot-workflows",
      version: 1,
      workflows: [
        { name: "Fine", steps: [{ kind: "notify", name: "N" }] },
        {
          name: "Broken one",
          steps: [{ kind: "notify", name: "N" }],
          connections: [{ from: 1, to: 5 }],
        },
      ],
    }),
  )
  const second = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_WORKFLOW_FILE_OPEN: workflowFile,
  })
  await resizeWindow(second.app, 1500, 1000)
  await openWorkflows(second.page)
  await second.page.getByTestId("wf-menu").click()
  await second.page.getByTestId("wf-menu-import-file").click()
  await expect(second.page.getByTestId("workflow-file-problem-text")).toContainText("Broken one")
  await expect(second.page.getByTestId("workflow-file-problem-text")).toContainText("connection 1")
  await shot(second.page, "s27-09-refused")
  await second.page.getByTestId("workflow-file-problem").getByRole("button").click()
  await expect(second.page.getByTestId("wf-list-empty")).toBeVisible()
  await second.app.close()
  await mock.close()
})
