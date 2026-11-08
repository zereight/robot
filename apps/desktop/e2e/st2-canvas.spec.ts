import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"

// Spec 001: the canvas is the main surface. It fills the workflow view, has no edge, pans and
// zooms; the node panel floats over it and folds; the run strip changes its height and folds.

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

test("canvas: it fills the view, pans and zooms, the node panel folds, and the strip resizes and folds", async () => {
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
  // At rest, the first line of the node panel body sits clear of its header edge.
  const [nHead, nBody] = await page.getByTestId("node-side-body").evaluate((el) => {
    let first = el.firstElementChild
    while (first?.firstElementChild) first = first.firstElementChild
    return [el.getBoundingClientRect().top, first?.getBoundingClientRect().top ?? 0]
  })
  expect(
    nBody - nHead,
    "node panel body starts below its header with space",
  ).toBeGreaterThanOrEqual(8)
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
  // When the panel opens, the selected node stays visible: the canvas scrolls it clear.
  const touches = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
  ) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  const foldedNode = await page.getByTestId("graph-node").nth(1).boundingBox()
  if (foldedNode === null || foldedSide === null) throw new Error("no box for node or panel")
  expect(touches(foldedNode, foldedSide), "node stays clear of the folded panel").toBe(false)
  await shot(page, "st2-02-panel-folded")
  await page.getByTestId("node-panel-fold").click()
  await expect(page.getByTestId("node-panel")).toBeVisible()
  const [openNode, openSide] = await Promise.all([
    page.getByTestId("graph-node").nth(1).boundingBox(),
    page.getByTestId("node-side").boundingBox(),
  ])
  if (openNode === null || openSide === null) throw new Error("no box for node or panel")
  expect(touches(openNode, openSide), "node stays clear of the open panel").toBe(false)
  // A tab round trip mounts the canvas again with the node still selected: it stays clear.
  await page.getByTestId("tab-memory").click()
  await page.getByTestId("tab-graph").click()
  await expect(page.getByTestId("node-panel")).toBeVisible()
  await expect
    .poll(
      async () => {
        const [n, p] = await Promise.all([
          page.getByTestId("graph-node").nth(1).boundingBox(),
          page.getByTestId("node-side").boundingBox(),
        ])
        return n !== null && p !== null && !touches(n, p)
      },
      { message: "node stays clear of the panel after a tab round trip" },
    )
    .toBe(true)
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

  // The canvas has no edge: a drag on an empty part moves the view past the graph, and so does a
  // two finger scroll. The selection stays clear.
  const node = page.getByTestId("graph-node").first()
  const home = await node.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 60)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 400, box.y + box.height - 260, { steps: 8 })
    await page.mouse.up()
  }
  const panned = await node.boundingBox()
  expect(home && panned ? Math.round(home.x - panned.x) : 0).toBe(400)
  expect(home && panned ? Math.round(home.y - panned.y) : 0).toBe(200)
  await expect(page.getByTestId("node-panel")).toHaveCount(0)
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(-150, 0)
  await expect
    .poll(async () => Math.round((await node.boundingBox())?.x ?? 0))
    .toBe(Math.round((panned?.x ?? 0) + 150))

  // Ctrl with the wheel (a trackpad pinch) zooms; the zoom value goes back to 100% and home.
  await page.keyboard.down("Control")
  await page.mouse.wheel(0, -50)
  await page.keyboard.up("Control")
  await expect(page.getByTestId("graph-zoom-reset")).not.toHaveText("100%")
  expect(((await node.boundingBox())?.width ?? 0) > (home?.width ?? 0)).toBe(true)
  await shot(page, "st2-03-canvas-zoomed")
  await page.getByTestId("graph-zoom-out").click()
  await page.getByTestId("graph-zoom-reset").click()
  await expect(page.getByTestId("graph-zoom-reset")).toHaveText("100%")
  expect(await node.boundingBox()).toEqual(home)

  // A drag on the top edge of the strip changes its height, and the canvas gets the rest.
  const strip = await page.getByTestId("run-strip").boundingBox()
  const edge = await page.getByTestId("strip-resize").boundingBox()
  if (edge) {
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
    await page.mouse.down()
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2 - 150, { steps: 5 })
    await page.mouse.up()
  }
  const taller = await page.getByTestId("run-strip").boundingBox()
  const lower = await page.getByTestId("graph-canvas").boundingBox()
  expect(strip && taller ? Math.round(taller.height - strip.height) : 0).toBe(150)
  expect(lower && canvas ? Math.round(canvas.height - lower.height) : 0).toBe(150)
  await page.getByTestId("strip-resize").press("ArrowDown")
  await expect
    .poll(async () => Math.round((await page.getByTestId("run-strip").boundingBox())?.height ?? 0))
    .toBe(Math.round((taller?.height ?? 0) - 16))
  const saved = (taller?.height ?? 0) - 16
  await shot(page, "st2-04-strip-taller")

  // The strip folds to its tab row, and the canvas gets the height.
  await page.getByTestId("strip-fold").click()
  await expect(page.getByTestId("runs-trigger")).toHaveCount(0)
  const folded = await page.getByTestId("graph-canvas").boundingBox()
  expect(folded && canvas ? folded.height > canvas.height + 100 : false).toBe(true)
  await shot(page, "st2-05-strip-folded")
  await first.app.close()

  // The fold stays after a restart; a press on a strip tab unfolds it.
  const again = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await expect(again.page.getByTestId("run-strip")).toHaveAttribute("data-folded", "true")
  await again.page.getByTestId("strip-tab-runs").click()
  await expect(again.page.getByTestId("runs-trigger")).toBeVisible()
  // The height stays after a restart too.
  const kept = await again.page.getByTestId("run-strip").boundingBox()
  expect(Math.round(kept?.height ?? 0)).toBe(Math.round(saved))
  await again.app.close()
})
