import { expect, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"

// Spec 001 (the studio): the list, the centre column and the panel column in one view.

const newWorkflow = async (
  page: import("@playwright/test").Page,
  name: string,
  button = "new-workflow-empty",
) => {
  await page.getByTestId(button).click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("workflow-view")).toBeVisible()
}

test("studio: the list, the canvas and the chat show at once; the selection survives a restart", async () => {
  const userData = freshUserData()
  let { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1280, 860)

  // No workflow: the list holds "New workflow", and the centre asks for a pick.
  await expect(page.getByTestId("new-workflow-empty")).toBeVisible()
  await expect(page.getByTestId("studio-pick")).toHaveText("Select a workflow in the list.")
  await expect(page.getByTestId("studio-chat-empty")).toHaveText("Open a workflow to chat.")
  await shot(page, "st1-01-empty")

  await newWorkflow(page, "Weekly")
  await newWorkflow(page, "Daily", "new-workflow")

  // The list, the canvas and the chat show at once. The header shows the check.
  await expect(page.getByTestId("studio-list")).toBeVisible()
  await expect(page.getByTestId("tab-graph")).toBeVisible()
  await expect(page.getByTestId("chat")).toBeVisible()
  await expect(page.getByTestId("workflow-header-check")).toHaveText("Check: Passed")
  // The list is alphabetical, and the open card is marked.
  await expect(page.getByTestId("workflow-row").nth(0)).toContainText("Daily")
  await expect(page.getByTestId("workflow-row").nth(1)).toContainText("Weekly")
  await expect(page.getByTestId("workflow-row").nth(0)).toHaveAttribute("data-selected", "true")
  await shot(page, "st1-02-wide")

  // Picking a card switches the centre and the chat.
  await page.getByTestId("workflow-row").nth(1).getByTestId("workflow-open").click()
  await expect(page.getByTestId("workflow-header")).toContainText("Weekly")
  await expect(page.getByTestId("workflow-row").nth(1)).toHaveAttribute("data-selected", "true")
  await app.close()

  // The selection survives a restart.
  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" }))
  await resizeWindow(app, 1280, 860)
  await expect(page.getByTestId("workflow-header")).toContainText("Weekly")
  await expect(page.getByTestId("workflow-row").nth(1)).toHaveAttribute("data-selected", "true")
  await app.close()
})

test("studio: a page fills the centre; the chat hides and shows again", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1280, 860)
  await newWorkflow(page, "Weekly")

  // The tasks page fills the centre column; the list and the chat stay.
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-header")).toBeVisible()
  await expect(page.getByTestId("studio-list")).toBeVisible()
  await expect(page.getByTestId("chat")).toBeVisible()
  await shot(page, "st1-03-tasks")
  // Picking a card returns to the open workflow.
  await page.getByTestId("workflow-open").click()
  await expect(page.getByTestId("workflow-view")).toBeVisible()

  // The header button hides the panel column and shows it again.
  await page.getByTestId("studio-toggle-chat").click()
  await expect(page.getByTestId("studio-panel")).toHaveCount(0)
  await page.getByTestId("studio-toggle-chat").click()
  await expect(page.getByTestId("chat")).toBeVisible()
  await app.close()
})

test("studio: in a narrow window the list and the chat open as overlays", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  await resizeWindow(app, 760, 700)

  // The rail narrows, and the list and the panel close.
  const rail = await page.getByTestId("rail").boundingBox()
  expect(rail?.width).toBe(56)
  await expect(page.getByTestId("studio-list")).toHaveCount(0)
  await expect(page.getByTestId("studio-panel")).toHaveCount(0)
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await shot(page, "st1-04-narrow")

  // Each header button opens its overlay; a click outside and Escape close them.
  await page.getByTestId("studio-show-list").click()
  await expect(page.getByTestId("studio-list")).toBeVisible()
  await shot(page, "st1-05-list-overlay")
  await page.getByTestId("studio-backdrop").click()
  await expect(page.getByTestId("studio-list")).toHaveCount(0)
  await page.getByTestId("studio-show-chat").click()
  await expect(page.getByTestId("studio-panel")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("studio-panel")).toHaveCount(0)
  await app.close()
})

test("studio: in a medium window the list opens as an overlay and the chat stays", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  await resizeWindow(app, 900, 700)

  // The list is closed, and the panel column stays.
  await expect(page.getByTestId("studio-list")).toHaveCount(0)
  await expect(page.getByTestId("chat")).toBeVisible()
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await shot(page, "st1-05-medium")

  // The header button opens the list as an overlay; picking a card closes it.
  await page.getByTestId("studio-show-list").click()
  await expect(page.getByTestId("studio-list")).toBeVisible()
  // A refresh of the list (here the check of the new workflow ends) is not a pick: the list stays.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const w = window as unknown as { robot: { on: (e: string, f: () => void) => void } }
        w.robot.on("workflows.changed", () => done())
        setTimeout(done, 2000)
      }),
  )
  await expect(page.getByTestId("studio-list")).toBeVisible()
  await page.getByTestId("workflow-open").click()
  await expect(page.getByTestId("studio-list")).toHaveCount(0)
  await expect(page.getByTestId("workflow-view")).toBeVisible()
  await app.close()
})

test("studio: the run strip shows the runs below the canvas, and the check on its tab", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1280, 860)
  await newWorkflow(page, "Weekly")

  // The strip shows below the open part, with the runs and the trigger.
  const tabs = await page.getByTestId("tab-graph").boundingBox()
  const strip = await page.getByTestId("run-strip").boundingBox()
  expect(strip && tabs ? strip.y > tabs.y : false).toBe(true)
  await expect(page.getByTestId("runs-none")).toBeVisible()
  await expect(page.getByTestId("runs-trigger")).toBeVisible()
  await shot(page, "st1-07-strip-runs")

  // The tab "Check" shows the result of the check.
  await page.getByTestId("strip-tab-check").click()
  await page.getByTestId("graph-check").click()
  await expect(page.getByTestId("check-state")).toHaveText("Passed")
  await expect(page.getByTestId("check-passed")).toContainText("no problem")
  await shot(page, "st1-08-strip-check")

  // "Close the check" returns to the runs.
  await page.getByTestId("check-close").click()
  await expect(page.getByTestId("runs-none")).toBeVisible()
  await app.close()
})

test("studio in Korean: the list, the canvas and the chat", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1280, 860)
  await expect(page.getByTestId("studio-pick")).toHaveText("목록에서 워크플로우를 선택하세요.")
  await newWorkflow(page, "주간 보고")
  await expect(page.getByTestId("studio-list")).toBeVisible()
  await expect(page.getByTestId("tab-graph")).toBeVisible()
  await expect(page.getByTestId("chat")).toBeVisible()
  await expect(page.getByTestId("workflow-header-check")).toHaveText("검사: 통과")
  await shot(page, "st1-06-wide-ko")
  await app.close()
})

test("toolbar: on a narrow canvas the labels shrink to icons and every button stays whole", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await newWorkflow(page, "Weekly")
  // A medium window: the list closes, the chat stays, and the canvas drops under 460 px.
  await resizeWindow(app, 820, 700)
  await expect(page.getByTestId("graph-toolbar")).toBeVisible()
  const overflow = await page
    .getByTestId("graph-toolbar")
    .evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow, "toolbar buttons fit without scrolling").toBeLessThanOrEqual(1)
  await shot(page, "st1-09-toolbar-icons")
  await app.close()
})
