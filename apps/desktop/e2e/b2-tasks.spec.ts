import { expect, type Page, test } from "@playwright/test"
import { launch, resizeWindow, shot, startRunCall } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 005 (Tasks page, Queue, Retry note, Quiet line), 001 (page buttons), 013 (Tasks at once).

test.setTimeout(60_000)

const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
const HANG = "[[hang]] hold"

type Invoke = (method: string, input?: unknown) => Promise<{ ok: boolean; value?: unknown }>

/**
 * Makes workflows with the nodes (one text node for each prompt, in a line) on the account of the
 * stand-in provider, with the same calls as the window. It returns the ids.
 */
const makeFlows = async (
  page: Page,
  openaiUrl: string,
  flows: readonly { name: string; prompts: string[]; level?: string }[],
) =>
  page.evaluate(
    async ({ openaiUrl, key, flows }) => {
      const invoke = (window as unknown as { robot: { invoke: Invoke } }).robot.invoke
      const call = async (method: string, input?: unknown) => {
        const result = await invoke(method, input)
        if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result)}`)
        return result.value as never
      }
      const servers = (await call("servers.list")) as { id: string; kind: string }[]
      const server = servers.find((s) => s.kind === "local")
      let accounts = (await call("providers.list")) as { id: string }[]
      if (accounts.length === 0) {
        await call("providers.connect", {
          kind: "openai",
          name: "Mock",
          baseUrl: openaiUrl,
          apiKey: key,
        })
        accounts = (await call("providers.list")) as { id: string }[]
      }
      const ids: string[] = []
      for (const flow of flows) {
        const made = (await call("workflows.create", {
          serverId: server?.id,
          name: flow.name,
        })) as {
          id: string
        }
        await call("workflows.setSelfImprovement", { id: made.id, enabled: false })
        if (flow.level) await call("workflows.setPermission", { id: made.id, level: flow.level })
        let before: string | undefined
        for (const [index, prompt] of flow.prompts.entries()) {
          const node = (await call("workflows.node.add", {
            workflowId: made.id,
            node: {
              kind: "text",
              name: `Step ${index + 1}`,
              x: 24 + index * 216,
              y: 24,
              prompt,
              accountId: accounts[0]?.id,
              model: "mock-fast",
            },
          })) as { id: string }
          if (before)
            await call("workflows.connect", {
              workflowId: made.id,
              from: before,
              to: node.id,
              optionId: null,
            })
          before = node.id
        }
        ids.push(made.id)
      }
      return ids
    },
    { openaiUrl, key: GOOD_KEY, flows },
  )

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

interface Row {
  id: string
  runId: string
  workflowName: string
  state: string
}
const tasks = (page: Page) => invokeCall<Row[]>(page, "tasks.list")
const taskOfRun = async (page: Page, runId: string) =>
  (await tasks(page)).find((t) => t.runId === runId)
const row = (page: Page, id: string) => page.locator(`[data-testid=task-row][data-id="${id}"]`)

const openTasks = async (page: Page) => {
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-page")).toBeVisible()
}

test("tasks page: the button opens it with the tabs Tasks and Events; the tab stays after a restart", async () => {
  const mock = await startMockProvider()
  const { app, page, userData } = await launch(undefined, env)
  await resizeWindow(app, 900, 640)
  const [flow] = await makeFlows(page, mock.openaiUrl, [{ name: "Report", prompts: ["hello"] }])
  await openTasks(page)
  await expect(page.getByTestId("tasks-empty")).toBeVisible()
  // The header line holds the two tabs; the Tasks tab is first and on.
  await expect(page.getByTestId("tasks-tab")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("events-tab")).toHaveText("Events")
  const runId = await startRunCall(page, flow ?? "")
  await expect(page.getByTestId("task-row")).toHaveCount(1)
  await expect(page.getByTestId("task-state")).toHaveText("Done")
  await expect(page.getByTestId("task-source")).toHaveText("By hand")
  await expect(page.getByTestId("task-row")).toContainText("Report")
  await shot(page, "b2-01-tasks-page")

  // The detail: node, input, result, three times, and the moments with clock times.
  await page.getByTestId("task-open").click()
  await expect(page.getByTestId("task-detail")).toBeVisible()
  await expect(page.getByTestId("task-result")).toHaveText("You said: hello")
  for (const t of ["wait", "first-reply", "total"])
    await expect(page.getByTestId(`task-time-${t}`)).not.toHaveText("—")
  await expect(page.getByTestId("task-moment")).toHaveCount(4)
  await expect(page.getByTestId("task-moments")).toContainText("Given")
  await expect(page.getByTestId("task-moments")).toContainText("Started")
  await expect(page.getByTestId("task-moments")).toContainText("Ended: Done")
  await expect(page.getByTestId("task-moments")).toContainText("Closed")
  await shot(page, "b2-02-task-detail")

  // Open the run: the workflow opens at the run view.
  await page.getByTestId("task-open-run").click()
  await expect(page.getByTestId("run-view")).toBeVisible()
  expect(runId).toBeTruthy()

  // The tab strip is a tab list: the arrow keys move between the tabs, the tab panel is named by
  // its tab.
  await openTasks(page)
  await expect(page.getByTestId("tasks-tab")).toHaveAttribute("tabindex", "0")
  await expect(page.getByTestId("events-tab")).toHaveAttribute("tabindex", "-1")
  await expect(page.getByTestId("tasks-page")).toHaveAttribute("role", "tabpanel")
  await expect(page.getByTestId("tasks-page")).toHaveAttribute(
    "aria-labelledby",
    "tasks-page-tab-tasks",
  )
  // Only the selected tab points to a panel: the panel of the other tab is not in the page.
  await expect(page.getByTestId("tasks-tab")).toHaveAttribute(
    "aria-controls",
    "tasks-page-panel-tasks",
  )
  await expect(page.getByTestId("events-tab")).not.toHaveAttribute("aria-controls", /.+/)
  await page.getByTestId("tasks-tab").focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByTestId("events-tab")).toBeFocused()
  await expect(page.getByTestId("events-tab")).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("ArrowLeft")
  await expect(page.getByTestId("tasks-tab")).toBeFocused()
  await expect(page.getByTestId("tasks-tab")).toHaveAttribute("aria-selected", "true")

  // The tab "Events" shows its list; a restart restores the last tab, and the button opens "Tasks".
  await page.getByTestId("events-tab").click()
  await expect(page.getByTestId("events-empty")).toHaveText("No event yet.")
  await app.close()
  const again = await launch(userData, env)
  await again.page.getByTestId("page-tasks").click()
  await expect(again.page.getByTestId("tasks-tab")).toHaveAttribute("aria-selected", "true")
  await again.page.getByTestId("events-tab").click()
  await again.app.close()
  const third = await launch(userData, env)
  await expect(third.page.getByTestId("events-tab")).toHaveAttribute("aria-selected", "true")
  await expect(third.page.getByTestId("events-empty")).toBeVisible()
  await third.page.getByTestId("page-workflows").click()
  await third.page.getByTestId("page-tasks").click()
  await expect(third.page.getByTestId("tasks-tab")).toHaveAttribute("aria-selected", "true")
  await third.app.close()
  await mock.close()
})

test("tasks at once: the field takes 1 to 8; a third task waits for a free slot; Stop starts it at once; a new number applies at once", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await resizeWindow(app, 900, 640)
  // The setting: 9 and 0 are refused and the old value stays; 2 is saved.
  await page.getByTestId("open-settings").click()
  const field = page.getByTestId("setting-tasks-at-once")
  await expect(field).toHaveValue("4")
  await field.fill("9")
  await expect(page.getByTestId("setting-tasks-at-once-row")).toContainText(
    "Use a whole number from 1 to 8.",
  )
  await field.blur()
  await expect(field).toHaveValue("4")
  await field.fill("0")
  await field.blur()
  await expect(field).toHaveValue("4")
  await field.fill("2")
  await field.blur()
  await expect(field).toHaveValue("2")
  await shot(page, "b2-03-setting-tasks-at-once")
  await page.getByTestId("settings-close").click()

  const [a, b, c] = await makeFlows(page, mock.openaiUrl, [
    { name: "Alpha", prompts: [HANG] },
    { name: "Beta", prompts: [HANG] },
    { name: "Gamma", prompts: [HANG] },
  ])
  const ra = await startRunCall(page, a ?? "")
  const rb = await startRunCall(page, b ?? "")
  await expect.poll(async () => (await taskOfRun(page, ra))?.state).toBe("running")
  await expect.poll(async () => (await taskOfRun(page, rb))?.state).toBe("running")
  const rc = await startRunCall(page, c ?? "")
  await expect.poll(async () => (await taskOfRun(page, rc))?.state).toBe("queued")
  await openTasks(page)
  const third = (await taskOfRun(page, rc))?.id ?? ""
  await expect(row(page, third).getByTestId("task-state")).toHaveText("Queued")
  await expect(row(page, third).getByTestId("task-reason")).toHaveText(
    "Waits for a free slot. Slots: 2",
  )
  await expect(page.locator("[data-testid=task-row][data-state=running]")).toHaveCount(2)
  await shot(page, "b2-04-waits-for-a-slot")

  // Stop one running task from its detail: the third starts at once.
  const first = (await taskOfRun(page, ra))?.id ?? ""
  await row(page, first).getByTestId("task-open").click()
  await page.getByTestId("task-stop").click()
  await expect(row(page, third).getByTestId("task-state")).toHaveText("Running")
  await expect(row(page, first).getByTestId("task-state")).toHaveText("Cancelled")
  await page.getByTestId("task-detail").getByRole("button", { name: "Close" }).click()

  // Start a fourth: it waits. Raise the number to 3 in Settings: it starts, the others go on.
  const [d] = await makeFlows(page, mock.openaiUrl, [{ name: "Delta", prompts: [HANG] }])
  const rd = await startRunCall(page, d ?? "")
  await expect.poll(async () => (await taskOfRun(page, rd))?.state).toBe("queued")
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-tasks-at-once").fill("3")
  await page.getByTestId("setting-tasks-at-once").blur()
  await page.getByTestId("settings-close").click()
  await expect.poll(async () => (await taskOfRun(page, rd))?.state).toBe("running")
  await expect.poll(async () => (await taskOfRun(page, rb))?.state).toBe("running")
  await expect.poll(async () => (await taskOfRun(page, rc))?.state).toBe("running")
  await app.close()
  await mock.close()
})

test("tasks at once in Korean: the reason reads in Korean", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 900, 640)
  await invokeCall(page, "settings.update", { tasksAtOnce: 1 })
  const [a, b] = await makeFlows(page, mock.openaiUrl, [
    { name: "가나", prompts: [HANG] },
    { name: "다라", prompts: [HANG] },
  ])
  await startRunCall(page, a ?? "")
  const rb = await startRunCall(page, b ?? "")
  await expect.poll(async () => (await taskOfRun(page, rb))?.state).toBe("queued")
  await openTasks(page)
  const queued = (await taskOfRun(page, rb))?.id ?? ""
  await expect(row(page, queued).getByTestId("task-reason")).toHaveText(
    "빈 실행 자리를 기다려요. 실행 자리: 1",
  )
  await expect(page.getByTestId("tasks-tab")).toHaveText("작업")
  await expect(page.getByTestId("events-tab")).toHaveText("이벤트")
  await expect(row(page, queued).getByTestId("task-run-next")).toHaveText("먼저 실행")
  await shot(page, "b2-05-tasks-ko")
  await app.close()
  await mock.close()
})

test("run next: the picked task starts first; the page says what a queued task waits behind", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await resizeWindow(app, 900, 640)
  const [a] = await makeFlows(page, mock.openaiUrl, [{ name: "Alpha", prompts: [HANG] }])
  const r1 = await startRunCall(page, a ?? "")
  await expect.poll(async () => (await taskOfRun(page, r1))?.state).toBe("running")
  const r2 = await startRunCall(page, a ?? "")
  const r3 = await startRunCall(page, a ?? "")
  await expect.poll(async () => (await taskOfRun(page, r2))?.state).toBe("queued")
  await expect.poll(async () => (await taskOfRun(page, r3))?.state).toBe("queued")
  await openTasks(page)
  const id2 = (await taskOfRun(page, r2))?.id ?? ""
  const id3 = (await taskOfRun(page, r3))?.id ?? ""
  // A queued task shows "Waits behind <node>" with its run; a running task has no Run next.
  await expect(row(page, id3).getByTestId("task-reason")).toContainText("Waits behind Step 1")
  await expect(
    row(page, (await taskOfRun(page, r1))?.id ?? "").getByTestId("task-run-next"),
  ).toHaveCount(0)
  // The two buttons "Run next" have names of their own.
  await expect(
    row(page, id2).getByRole("button", { name: "Run next: Alpha, node 1 “Step 1”" }),
  ).toHaveCount(1)
  const names = await page
    .getByTestId("task-run-next")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))
  expect(names).toHaveLength(2)
  expect(names[0]).toBeTruthy()
  await row(page, id3).getByTestId("task-run-next").click()
  await shot(page, "b2-06-run-next")
  // The running task ends (Stop): the third starts first, the second keeps waiting.
  await invokeCall(page, "runs.stop", { runId: r1 })
  await expect(row(page, id3).getByTestId("task-state")).toHaveText("Running")
  await expect(row(page, id2).getByTestId("task-state")).toHaveText("Queued")
  await app.close()
  await mock.close()
})

test("a background refetch of the list keeps the rows: the focus on a row stays", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await resizeWindow(app, 900, 640)
  const [a] = await makeFlows(page, mock.openaiUrl, [{ name: "Alpha", prompts: [HANG] }])
  const r1 = await startRunCall(page, a ?? "")
  await expect.poll(async () => (await taskOfRun(page, r1))?.state).toBe("running")
  await openTasks(page)
  const id1 = (await taskOfRun(page, r1))?.id ?? ""
  await expect(page.getByTestId("task-row")).toHaveCount(1)
  // Mark the node of the button and the filter option, and put the focus on the button.
  const button = row(page, id1).getByTestId("task-open")
  await button.focus()
  await button.evaluate((el) => {
    el.setAttribute("data-mounted-once", "yes")
  })
  await page
    .getByTestId("tasks-filter-workflow")
    .locator("option", { hasText: "Alpha" })
    .evaluate((el) => el.setAttribute("data-mounted-once", "yes"))
  // A second run changes the list: the page reads it again in the background.
  const r2 = await startRunCall(page, a ?? "")
  await expect(page.getByTestId("task-row")).toHaveCount(2)
  await expect.poll(async () => (await taskOfRun(page, r2))?.state).toBe("queued")
  await expect(button).toBeFocused()
  await expect(button).toHaveAttribute("data-mounted-once", "yes")
  await expect(
    page.getByTestId("tasks-filter-workflow").locator("option", { hasText: "Alpha" }),
  ).toHaveAttribute("data-mounted-once", "yes")
  await invokeCall(page, "runs.stop", { runId: r1 })
  await invokeCall(page, "runs.stop", { runId: r2 })
  await app.close()
  await mock.close()
})

test("a task that waits for the user says why; the approval word of 005", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await resizeWindow(app, 900, 640)
  const [a] = await makeFlows(page, mock.openaiUrl, [
    { name: "Shell", prompts: ['tool run_command {"command":"echo wait-test"}'], level: "ask_all" },
  ])
  const run = await startRunCall(page, a ?? "")
  await expect.poll(async () => (await taskOfRun(page, run))?.state).toBe("waiting")
  await openTasks(page)
  const id = (await taskOfRun(page, run))?.id ?? ""
  await expect(row(page, id).getByTestId("task-state")).toHaveText("Waiting for you")
  await expect(row(page, id).getByTestId("task-reason")).toContainText(
    "Waits for your approval of the step: echo wait-test",
  )
  await shot(page, "b2-07-waits-for-approval")
  await app.close()
  await mock.close()
})

test("filters: state, workflow and source narrow the table; a filter with no row says so", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await resizeWindow(app, 900, 640)
  const [a, b] = await makeFlows(page, mock.openaiUrl, [
    { name: "Alpha", prompts: ["fine"] },
    { name: "Beta", prompts: ["[[blocked]]"] },
  ])
  await startRunCall(page, a ?? "")
  await startRunCall(page, b ?? "")
  await openTasks(page)
  await expect(page.getByTestId("task-row")).toHaveCount(2)
  await page.getByTestId("tasks-filter-state").selectOption("blocked")
  await expect(page.getByTestId("task-row")).toHaveCount(1)
  await expect(page.getByTestId("task-row")).toContainText("Beta")
  await expect(page.getByTestId("task-reason")).toHaveText("Blocked: the file is missing")
  await page.getByTestId("tasks-filter-state").selectOption("")
  await page.getByTestId("tasks-filter-workflow").selectOption({ label: "Alpha" })
  await expect(page.getByTestId("task-row")).toHaveCount(1)
  await expect(page.getByTestId("task-row")).toContainText("Alpha")
  await page.getByTestId("tasks-filter-workflow").selectOption("")
  await page.getByTestId("tasks-filter-source").selectOption("schedule")
  await expect(page.getByTestId("tasks-no-match")).toHaveText("No task matches.")
  await page.getByTestId("tasks-filter-source").selectOption("hand")
  await expect(page.getByTestId("task-row")).toHaveCount(2)
  await shot(page, "b2-08-filters")
  await app.close()
  await mock.close()
})

test("retry note: a failed task whose first try changed things shows the note; Back starts nothing; Retry anyway starts a new task", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await resizeWindow(app, 900, 700)
  await invokeCall(page, "settings.update", { stepLimit: 20 })
  const [a, b] = await makeFlows(page, mock.openaiUrl, [
    { name: "Writer", prompts: ['tools 25 run_command {"command":"echo changed"}'], level: "full" },
    { name: "Reader", prompts: ["[[fail]] x"] },
  ])
  const run = await startRunCall(page, a ?? "")
  await expect
    .poll(async () => (await taskOfRun(page, run))?.state, { timeout: 30_000 })
    .toBe("failed")
  await openTasks(page)
  const id = (await taskOfRun(page, run))?.id ?? ""
  await expect(row(page, id).getByTestId("task-reason")).toHaveText("Step limit reached (20).")
  await row(page, id).getByTestId("task-open").click()
  await expect(page.getByTestId("task-progress-line")).toBeVisible()
  await page.getByTestId("task-retry").click()
  const note = page.getByTestId("retry-note")
  await expect(note).toBeVisible()
  await expect(page.getByTestId("retry-note-step")).toHaveCount(5)
  await expect(page.getByTestId("retry-note-more")).toHaveText("and 15 more")
  await shot(page, "b2-09-retry-note")
  // Back changes nothing.
  await page.getByTestId("retry-back").click()
  await expect(note).toHaveCount(0)
  expect((await tasks(page)).length).toBe(1)
  // Retry anyway starts a new task.
  await page.getByTestId("task-retry").click()
  await page.getByTestId("retry-anyway").click()
  await expect.poll(async () => (await tasks(page)).length).toBe(2)
  await page.getByTestId("task-detail").getByRole("button", { name: "Close" }).click()

  // A task that changed nothing starts at once on Retry: no note.
  const run2 = await startRunCall(page, b ?? "")
  await expect
    .poll(async () => (await taskOfRun(page, run2))?.state, { timeout: 30_000 })
    .toBe("failed")
  const id2 = (await taskOfRun(page, run2))?.id ?? ""
  await row(page, id2).getByTestId("task-open").click()
  await page.getByTestId("task-retry").click()
  await expect(page.getByTestId("retry-note")).toHaveCount(0)
  await expect.poll(async () => (await tasks(page)).length).toBe(4)
  await app.close()
  await mock.close()
})

test("the 21st waiting start is refused with the name of the workflow", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await resizeWindow(app, 900, 640)
  const [a] = await makeFlows(page, mock.openaiUrl, [{ name: "Weekly", prompts: [HANG] }])
  for (let i = 0; i < 21; i++) await startRunCall(page, a ?? "")
  // The workflow view has the Run button of the window.
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("workflow-open").first().click()
  await expect(page.getByTestId("workflow-run")).toBeVisible()
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("toast-error")).toContainText(
    "Weekly has 20 tasks that wait. Try again later.",
  )
  await shot(page, "b2-10-queue-full")
  await app.close()
  await mock.close()
})

test("quiet line: a turn with no sign of life shows 'No answer from <account> for <time>' on the Tasks page, and Stop ends it", async () => {
  test.setTimeout(100_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(undefined, env)
  await resizeWindow(app, 900, 640)
  // The silent limit is 1 minute: the quiet time is half of it, 30 seconds.
  await invokeCall(page, "settings.update", { silentLimit: 1 })
  const [a] = await makeFlows(page, mock.openaiUrl, [{ name: "Quiet", prompts: [HANG] }])
  const run = await startRunCall(page, a ?? "")
  await openTasks(page)
  await expect.poll(async () => (await taskOfRun(page, run))?.state).toBe("running")
  const id = (await taskOfRun(page, run))?.id ?? ""
  await expect(row(page, id).getByTestId("task-state")).toHaveText("Running")
  await expect(row(page, id).getByTestId("task-quiet")).toHaveText(
    /^No answer from Mock for 0:3\d$/,
    {
      timeout: 45_000,
    },
  )
  await shot(page, "b2-11-quiet-line")
  // The clock counts on once each second.
  const first = await row(page, id).getByTestId("task-quiet").textContent()
  await expect(row(page, id).getByTestId("task-quiet")).not.toHaveText(first ?? "")
  await invokeCall(page, "runs.stop", { runId: run })
  await expect(row(page, id).getByTestId("task-state")).toHaveText("Cancelled")
  await expect(row(page, id).getByTestId("task-quiet")).toHaveCount(0)
  await app.close()
  await mock.close()
})
