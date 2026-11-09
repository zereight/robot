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

// The dot grid of the canvas: the space on the screen between two dots that show, and the place
// in the graph of one dot that shows. The dots that show are at that place plus each multiple of
// the space divided by the zoom. A dot of the full grid is at 8 + 16n (the centre of a 16 px cell).
const dotGrid = (page: Page) =>
  page.getByTestId("graph-canvas").evaluate((canvas) => {
    const view = canvas.querySelector('[data-testid="graph-view"]')
    if (!view) throw new Error("no graph view")
    const m = new DOMMatrix(getComputedStyle(view).transform)
    const style = getComputedStyle(canvas)
    const gap = Number.parseFloat(style.backgroundSize)
    const [bx = Number.NaN, by = Number.NaN] = style.backgroundPosition
      .split(" ")
      .map(Number.parseFloat)
    return {
      gap,
      viewX: m.e,
      x: (bx + gap / 2 - m.e) / m.a,
      y: (by + gap / 2 - m.f) / m.a,
    }
  })
/** The distance from `value` to the nearest `base + step * n`. */
const offGrid = (value: number, step: number, base: number) => {
  const r = (((value - base) % step) + step) % step
  return Math.min(r, step - r)
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
  // Start from the home view: the open panel moved the view to keep its node clear.
  await page.getByTestId("graph-zoom-reset").click()
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

  // Spec 001, dot grid: the space between two dots that show is 12 px or more, from centre to
  // centre. Every dot shows from 75%, every second dot from 37.5%, every fourth dot below. Each
  // dot that shows is a dot of the full grid. Zoom around a point off the corner, so the view
  // moves too.
  if (!box) throw new Error("no box for the canvas")
  const zoomValue = page.getByTestId("graph-zoom-reset")
  const ctrlZoom = async (factor: number) => {
    await page.mouse.move(box.x + 301, box.y + 187)
    let left = -100 * Math.log(factor)
    await page.keyboard.down("Control")
    while (Math.abs(left) > 1e-9) {
      const step = Math.max(-50, Math.min(50, left))
      await page.mouse.wheel(0, step)
      left -= step
    }
    await page.keyboard.up("Control")
  }
  const spaces: [zoom: number, space: number][] = [
    [2, 32],
    [1, 16],
    [0.75, 12],
    [0.74, 23.68],
    [0.5, 16],
    [0.375, 12],
    [0.37, 23.68],
    [0.25, 16],
  ]
  for (const [zoom, space] of spaces) {
    await zoomValue.click()
    await expect(zoomValue).toHaveText("100%")
    await ctrlZoom(zoom)
    await expect(zoomValue).toHaveText(`${Math.round(zoom * 100)}%`)
    const dots = await dotGrid(page)
    expect(dots.gap, `space between dots at ${zoom * 100}%`).toBeCloseTo(space, 3)
    expect(offGrid(dots.x, 16, 8), `dots on the full grid at ${zoom * 100}%`).toBeLessThan(0.05)
    expect(offGrid(dots.y, 16, 8), `dots on the full grid at ${zoom * 100}%`).toBeLessThan(0.05)
  }

  // At 50%, a drag in each direction does not change which dots show. At 25%, each dot that
  // shows is a dot that showed at 50%.
  await zoomValue.click()
  await ctrlZoom(0.5)
  await expect(zoomValue).toHaveText("50%")
  const half = await dotGrid(page)
  const drag = async (x: number, y: number, dx: number, dy: number) => {
    const before = await dotGrid(page)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 8 })
    await page.mouse.up()
    const after = await dotGrid(page)
    expect(Math.round(after.viewX - before.viewX), "the drag moves the view").toBe(dx)
    expect(offGrid(after.x, 32, half.x), "a drag keeps the same dots").toBeLessThan(0.05)
    expect(offGrid(after.y, 32, half.y), "a drag keeps the same dots").toBeLessThan(0.05)
  }
  await drag(box.x + box.width / 2, box.y + box.height - 60, -333, -217)
  await drag(box.x + 80, box.y + 200, 411, 251)
  await ctrlZoom(0.5)
  await expect(zoomValue).toHaveText("25%")
  const quarter = await dotGrid(page)
  expect(offGrid(quarter.x, 32, half.x), "25% dots are 50% dots").toBeLessThan(0.05)
  expect(offGrid(quarter.y, 32, half.y), "25% dots are 50% dots").toBeLessThan(0.05)
  await zoomValue.click()
  await expect(zoomValue).toHaveText("100%")

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
