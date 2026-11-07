import { expect, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Slice B6: the backup model of a text node (spec 006, "Backup model"; 010, 005, 012). The main
// account is a stand-in that can be made to answer every request with a spent limit. The backup
// account is a second stand-in that always answers. The spec looks at the editor, the first run that
// goes to the backup, the hold on the node, "Use <main model> now", a restart, and the same screens
// in Korean.

test.setTimeout(120_000)

const PLAN = "Plan limit reached for this account."
const chatRequests = (mock: { requests: { path: string }[] }) =>
  mock.requests.filter((r) => r.path.endsWith("/chat/completions")).length

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("graph-editor")).toBeVisible()
}

/**
 * Turns off the two things that call a model after a run (the memory and the self-improvement of
 * the responsible document), so that the test counts the requests of the nodes only.
 */
const quietWorkflow = (page: Page) =>
  page.evaluate(async () => {
    type Invoke = (m: string, i?: unknown) => Promise<{ ok: boolean; value?: unknown }>
    const invoke = (window as unknown as { robot: { invoke: Invoke } }).robot.invoke
    const servers = (await invoke("servers.list")).value as { id: string; kind: string }[]
    const server = servers.find((s) => s.kind === "local")
    const flows = (await invoke("workflows.list", { serverId: server?.id })).value as {
      id: string
    }[]
    for (const flow of flows) {
      await invoke("workflows.setSelfImprovement", { id: flow.id, enabled: false })
      await invoke("memory.setEnabled", { workflowId: flow.id, enabled: false })
    }
  })

const runOnce = async (page: Page) => {
  await page.getByTestId("tab-runs").click()
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-view")).toBeVisible()
  await expect(page.getByTestId("run-state")).not.toHaveText(/Running|Queued|실행 중|대기 중/)
}

test("backup model: the editor, the first run on the backup, the hold, 'Use the main model now', a restart, Korean", async () => {
  const main = await startMockProvider()
  const backup = await startMockProvider()
  const userData = freshUserData()
  let { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1100, 800)
  try {
    await connectMock(page, main.openaiUrl, GOOD_KEY, "Main")
    await connectMock(page, backup.openaiUrl, GOOD_KEY, "Backup")
    await newWorkflow(page, "Weekly")
    await quietWorkflow(page)

    // A decision node has no backup model: its panel has no such choice.
    await page.getByTestId("graph-add-decision").click()
    await expect(page.getByTestId("node-panel")).toBeVisible()
    await expect(page.getByTestId("node-backup")).toHaveCount(0)
    await page.getByTestId("node-delete").click()
    await page.getByTestId("node-delete-confirm").click()
    await expect(page.getByTestId("graph-node")).toHaveCount(0)

    // 1. A text node on the main model. The backup starts as "None", and it needs a main choice.
    await page.getByTestId("graph-add-text").click()
    await page.getByTestId("node-name").fill("Draft")
    await page.getByTestId("node-name").press("Tab")
    await page.getByTestId("node-prompt").fill("write it")
    await page.getByTestId("node-prompt").press("Tab")
    await expect(page.getByTestId("node-backup-no-main")).toBeVisible()
    await page.getByTestId("node-provider").selectOption({ label: "Main" })
    await page.getByTestId("node-model").selectOption("mock-fast")
    await expect(page.getByTestId("node-backup-none")).toHaveText("None")
    await shot(page, "b6-01-editor-none")

    // 2. The same choice as the main one is refused, with the reason. A different one saves.
    await page.getByTestId("node-backup-choose").click()
    await page.getByTestId("node-backup-provider").selectOption({ label: "Main" })
    await page.getByTestId("node-backup-model").selectOption("mock-fast")
    await expect(page.getByTestId("node-backup-same")).toBeVisible()
    await shot(page, "b6-02-editor-same")
    await page.getByTestId("node-backup-provider").selectOption({ label: "Backup" })
    await page.getByTestId("node-backup-model").selectOption("gpt-5")
    await expect(page.getByTestId("node-backup-same")).toHaveCount(0)
    await expect(page.getByTestId("node-backup-remove")).toBeVisible()
    await expect(page.getByTestId("node-backup-hold")).toHaveCount(0)
    await shot(page, "b6-03-editor-backup")
    // A provider alone is not a choice: the saved backup stays until a whole new one is made.
    await page.getByTestId("node-backup-provider").selectOption({ label: "Main" })
    await expect(page.getByTestId("node-backup-remove")).toBeVisible()
    await page.getByTestId("node-backup-provider").selectOption({ label: "Backup" })
    await page.getByTestId("node-backup-model").selectOption("gpt-5")
    await expect(page.getByTestId("node-backup-remove")).toBeVisible()

    // 3. The main account spends its plan limit, which resets in 2 hours. The run goes on with the
    // backup, from the start. The run view shows the muted line and "Backup until" with the button.
    main.setFailure({ status: 429, message: PLAN, retryAfter: 7200 })
    await runOnce(page)
    await expect(page.getByTestId("run-state")).toHaveText("Done")
    await expect(page.getByTestId("run-node-result-1")).toHaveText("You said: write it")
    await expect(page.getByTestId("run-node-backup-line-1")).toContainText(
      "mock-fast reached its limit. gpt-5 goes on. The limit resets at ",
    )
    await expect(page.getByTestId("run-node-backup-1-until")).toHaveText(/^Backup until \S/)
    await expect(page.getByTestId("run-node-backup-1-use-main")).toHaveText("Use mock-fast now")
    expect(chatRequests(main)).toBe(1)
    expect(chatRequests(backup)).toBe(1)
    await shot(page, "b6-04-run-view-hold")

    // 4. The editor shows the hold too. The next run goes to the backup at once: no second line.
    await page.getByTestId("run-back").click()
    await page.getByTestId("tab-graph").click()
    await page.getByTestId("graph-node").first().click()
    await expect(page.getByTestId("node-backup-hold-until")).toHaveText(/^Backup until \S/)
    await expect(page.getByTestId("node-backup-hold-use-main")).toHaveText("Use mock-fast now")
    await shot(page, "b6-05-editor-hold")
    await runOnce(page)
    await expect(page.getByTestId("run-state")).toHaveText("Done")
    expect(chatRequests(main)).toBe(1)
    expect(chatRequests(backup)).toBe(2)
    await expect(page.getByTestId("run-node-backup-line-1")).toHaveCount(0)
    await page.getByTestId("run-back").click()

    // 5. "Use mock-fast now" ends the hold. The next run tries the main model, which is still at
    // its limit: the hold starts again, and the run view shows no second line.
    await page.getByTestId("tab-graph").click()
    await page.getByTestId("graph-node").first().click()
    await page.getByTestId("node-backup-hold-use-main").click()
    await expect(page.getByTestId("node-backup-hold")).toHaveCount(0)
    await runOnce(page)
    await expect(page.getByTestId("run-state")).toHaveText("Done")
    expect(chatRequests(main)).toBe(2)
    expect(chatRequests(backup)).toBe(3)
    await expect(page.getByTestId("run-node-backup-line-1")).toHaveCount(0)
    await expect(page.getByTestId("run-node-backup-1-until")).toBeVisible()

    // 6. The hold stays after the app is closed and opened again, here with Korean words.
    await app.close()
    ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
    await resizeWindow(app, 1100, 800)
    // The window opens the workflow that was open, or its list: open the first one if it is a list.
    await expect(
      page.getByTestId("tab-graph").or(page.getByTestId("workflow-open").first()),
    ).toBeVisible()
    if (await page.getByTestId("workflow-open").count())
      await page.getByTestId("workflow-open").first().click()
    await page.getByTestId("tab-graph").click()
    await page.getByTestId("graph-node").first().click()
    await expect(page.getByTestId("node-backup-hold-until")).toContainText("백업 사용")
    await expect(page.getByTestId("node-backup-hold-use-main")).toHaveText("지금 mock-fast 쓰기")
    await expect(page.getByTestId("node-backup")).toContainText("백업 모델")
    await shot(page, "b6-06-editor-hold-ko")
    await runOnce(page)
    await expect(page.getByTestId("run-node-backup-1-until")).toContainText("백업 사용")
    await shot(page, "b6-07-run-view-hold-ko")
  } finally {
    await app.close()
    await main.close()
    await backup.close()
  }
})

test("backup model: a key that is not valid does not move the run, and a backup can be removed", async () => {
  const main = await startMockProvider()
  const backup = await startMockProvider()
  const { app, page } = await launch(undefined, { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await connectMock(page, main.openaiUrl, GOOD_KEY, "Main")
    await connectMock(page, backup.openaiUrl, GOOD_KEY, "Backup")
    await newWorkflow(page, "Weekly")
    await quietWorkflow(page)
    await page.getByTestId("graph-add-text").click()
    await page.getByTestId("node-prompt").fill("write it")
    await page.getByTestId("node-prompt").press("Tab")
    await page.getByTestId("node-provider").selectOption({ label: "Main" })
    await page.getByTestId("node-model").selectOption("mock-fast")
    await page.getByTestId("node-backup-choose").click()
    await page.getByTestId("node-backup-provider").selectOption({ label: "Backup" })
    await page.getByTestId("node-backup-model").selectOption("gpt-5")
    await expect(page.getByTestId("node-backup-remove")).toBeVisible()

    // The main account says that its key is not valid: no switch, the run fails with that reason.
    main.setFailure({ status: 401, message: "Invalid API key." })
    await runOnce(page)
    await expect(page.getByTestId("run-state")).toHaveText("Failed")
    expect(chatRequests(backup)).toBe(0)
    await expect(page.getByTestId("run-node-backup-line-1")).toHaveCount(0)
    await expect(page.getByTestId("run-node-backup-1")).toHaveCount(0)
    await shot(page, "b6-08-key-not-valid")
    await page.getByTestId("run-back").click()

    // Remove the backup: the node shows "None" again.
    await page.getByTestId("tab-graph").click()
    await page.getByTestId("graph-node").first().click()
    await page.getByTestId("node-backup-remove").click()
    await expect(page.getByTestId("node-backup-none")).toHaveText("None")
  } finally {
    await app.close()
    await main.close()
    await backup.close()
  }
})
