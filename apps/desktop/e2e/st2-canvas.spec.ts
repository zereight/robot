import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"

// Spec 001: the canvas is the main surface. It fills the workflow view, the node panel floats
// over it and folds, and the run strip folds.

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

test("canvas: it fills the view, the node panel floats over it and folds, and the strip folds", async () => {
  const userData = freshUserData()
  const first = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  const page = first.page
  await resizeWindow(first.app, 1440, 900)
  await newWorkflow(page, "Weekly")
  await page.getByTestId("graph-add-text").click()
  await page.getByTestId("graph-add-text").click()
  await expect(page.getByTestId("graph-node")).toHaveCount(2)
  // A new node is selected; Escape closes its panel.
  await page.getByTestId("graph-canvas").press("Escape")
  await expect(page.getByTestId("node-panel")).toHaveCount(0)

  // The canvas takes the whole width of the workflow view.
  const view = await page.getByTestId("workflow-view").boundingBox()
  const canvas = await page.getByTestId("graph-canvas").boundingBox()
  expect(view && canvas ? Math.abs(view.width - canvas.width) < 2 : false).toBe(true)

  // A selected node opens the panel over the top right corner: the canvas keeps its full size,
  // and the panel does not cover the floating buttons.
  await page.getByTestId("graph-node").first().click()
  await expect(page.getByTestId("node-panel")).toBeVisible()
  const withPanel = await page.getByTestId("graph-canvas").boundingBox()
  const side = await page.getByTestId("node-side").boundingBox()
  const tools = await page.getByTestId("graph-versions-toggle").boundingBox()
  expect(withPanel?.width).toBe(canvas?.width)
  expect(withPanel?.height).toBe(canvas?.height)
  expect(withPanel && side ? side.x + side.width <= withPanel.x + withPanel.width : false).toBe(
    true,
  )
  expect(
    side && tools ? tools.x + tools.width <= side.x || tools.y + tools.height <= side.y : false,
  ).toBe(true)
  await shot(page, "st2-01-panel-floats")

  // The fold button folds the panel to its header; the next node opens folded too.
  const unfolded = side?.height ?? 0
  await page.getByTestId("node-panel-fold").click()
  await expect(page.getByTestId("node-panel")).toBeHidden()
  const foldedSide = await page.getByTestId("node-side").boundingBox()
  expect(foldedSide ? foldedSide.height < unfolded / 2 : false).toBe(true)
  await page.getByTestId("graph-node").nth(1).click()
  await expect(page.getByTestId("node-side-title")).toContainText("2.")
  await expect(page.getByTestId("node-panel")).toBeHidden()
  await shot(page, "st2-02-panel-folded")
  await page.getByTestId("node-panel-fold").click()
  await expect(page.getByTestId("node-panel")).toBeVisible()
  await page.getByTestId("graph-versions-toggle").click()
  await expect(page.getByTestId("graph-versions-toggle")).toHaveAttribute("aria-pressed", "true")
  await page.getByTestId("graph-versions-toggle").click()

  // Escape closes the panel; a click on an empty part clears the selection too.
  await page.getByTestId("graph-canvas").press("Escape")
  await expect(page.getByTestId("node-panel")).toHaveCount(0)
  await page.getByTestId("graph-node").first().click()
  await page.getByTestId("node-panel-close").click()
  await expect(page.getByTestId("node-panel")).toHaveCount(0)
  await page.getByTestId("graph-node").first().click()
  const box = await page.getByTestId("graph-canvas").boundingBox()
  if (box) await page.mouse.click(box.x + 40, box.y + box.height - 40)
  await expect(page.getByTestId("node-panel")).toHaveCount(0)

  // The strip folds to its tab row, and the canvas gets the height.
  await page.getByTestId("strip-fold").click()
  await expect(page.getByTestId("runs-trigger")).toHaveCount(0)
  const folded = await page.getByTestId("graph-canvas").boundingBox()
  expect(folded && canvas ? folded.height > canvas.height + 100 : false).toBe(true)
  await shot(page, "st2-03-strip-folded")
  await first.app.close()

  // The fold stays after a restart; a press on a strip tab unfolds it.
  const again = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await expect(again.page.getByTestId("run-strip")).toHaveAttribute("data-folded", "true")
  await again.page.getByTestId("strip-tab-runs").click()
  await expect(again.page.getByTestId("runs-trigger")).toBeVisible()
  await again.app.close()
})
