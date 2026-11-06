import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const allowedLatin = new Set([
  "ROBot",
  "OpenAI",
  "Anthropic",
  "API",
  "URL",
  "input",
  "trigger",
  "sudo",
])

/** Latin words in a part of the screen. Data typed by the user or the mock is cut out first. */
const latinWords = async (page: Page, selector: string) => {
  const text = await page.locator(selector).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    for (const skip of clone.querySelectorAll("[data-user-data], pre, textarea, input, select"))
      skip.remove()
    return clone.textContent ?? ""
  })
  const words = text.replace(/\{\{\w+\}\}/g, "").replace(/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/g, "")
  return (words.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !allowedLatin.has(w))
}

test("workflows: a run of a flow, and the editor survives a restart", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A workflow with a schedule trigger and one agent step. The triggers are manual and schedule:
  // no trigger "message in a channel".
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("wf-new").click()
  await page.getByTestId("wf-name").fill("On deploy")
  await expect(page.getByTestId("wf-trigger-kind").locator("option")).toHaveCount(2)
  await page.getByTestId("wf-trigger-kind").selectOption("schedule")
  await expect(page.getByTestId("wf-trigger-schedule")).toBeVisible()
  await page.getByTestId("wf-add-agent").click()
  await page.getByTestId("wf-step-prompt").fill("Handle the deploy")
  await page.getByTestId("wf-save").click()

  // A run of the flow.
  await page.getByTestId("wf-run").click()
  await expect(page.getByTestId("wf-run-row")).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByTestId("wf-run-row")).toContainText("Done", { timeout: 20_000 })
  await page.getByTestId("wf-run-step").first().locator("summary").click()
  await expect(page.getByTestId("wf-run-step").first()).toContainText("Handle the deploy")
  await shot(page, "s16-01-run")

  // The graph and the trigger are saved: close the app, open again.
  await app.close()
  const second = await launch(userData, env)
  await resizeWindow(second.app, 1500, 1000)
  await second.page.getByTestId("page-workflows").click()
  await second.page.getByTestId("wf-open").click()
  await expect(second.page.getByTestId("wf-node")).toHaveCount(1)
  await expect(second.page.getByTestId("wf-trigger-kind")).toHaveValue("schedule")
  await expect(second.page.getByTestId("wf-run-row")).toHaveCount(1)
  await second.app.close()
  await mock.close()
})

test("korean: routines, workflows, approval cards and memory have no English left", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "에이다")

  // Routines page, dialog and list.
  await page.getByTestId("page-routines").click()
  await expect(page.getByTestId("routines-view")).toBeVisible()
  expect(await latinWords(page, "[data-testid=routines-view]")).toEqual([])
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("아침 점검")
  await page.getByTestId("routine-prompt").fill("좋은 아침이라고 말해줘")
  expect(await latinWords(page, "[data-testid=routine-dialog]")).toEqual([])
  for (const kind of ["once", "every", "weekly", "cron"]) {
    await page.getByTestId("routine-kind").selectOption(kind)
    expect(await latinWords(page, "[data-testid=routine-dialog]"), `kind ${kind}`).toEqual([])
  }
  await page.getByTestId("routine-kind").selectOption("daily")
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(1)
  expect(await latinWords(page, "[data-testid=routines-view]")).toEqual([])
  await shot(page, "s16-02-routines-ko")
  await page.getByTestId("routine-view").getByText("주", { exact: true }).click()
  expect(await latinWords(page, "[data-testid=routines-view]")).toEqual([])

  // Workflows list and editor.
  await page.getByTestId("page-workflows").click()
  expect(await latinWords(page, "[data-testid=workflows-page]")).toEqual([])
  await page.getByTestId("wf-new").click()
  for (const kind of ["agent", "condition", "approval", "notify"])
    await page.getByTestId(`wf-add-${kind}`).click()
  expect(await latinWords(page, "[data-testid=workflows-page]")).toEqual([])
  await page.getByTestId("wf-node").first().click()
  expect(await latinWords(page, "[data-testid=workflows-page]")).toEqual([])
  await shot(page, "s16-03-editor-ko")

  // An approval card and the browser bar in a chat.
  await page.getByTestId("page-chats").click()
  await page
    .getByTestId("chat-start")
    .first()
    .waitFor()
    .catch(() => {})
  await page.getByText("에이다", { exact: true }).first().click()
  await page.getByTestId("composer-input").fill('TOOL run_command {"command":"sudo ls"}')
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  expect(await latinWords(page, "[data-testid=ask-card]")).toEqual([])
  await shot(page, "s16-04-approval-ko")
  await page.getByTestId("ask-deny").click()
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

  // Profile dialog: permission, memory.
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("memory-panel")).toBeVisible()
  expect(await latinWords(page, "[data-testid=agent-profile]")).toEqual([])
  await shot(page, "s16-05-profile-ko")
  await app.close()
})
