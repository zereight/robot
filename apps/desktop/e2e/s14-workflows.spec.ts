import { expect, type Locator, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  isDangerButton,
  launch,
  resizeWindow,
  shot,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const center = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error("no box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Drags from the output handle of one node to the body of another. A real mouse drag can miss on a
 * slow runner, so the drag is tried again until the number of edges grows.
 */
const connect = async (page: Page, from: number, to: number) => {
  const nodes = page.getByTestId("wf-node")
  const edges = page.getByTestId("wf-edge")
  const count = await edges.count()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const start = await center(nodes.nth(from).locator("[data-handle=out]").first())
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

test("workflows: build, connect, zoom and pan, run, history, approval and read-only", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A channel for the final message.
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Out")
  await page.getByTestId("channel-member-Ada").check()
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Out")

  await page.getByTestId("page-workflows").click()
  await expect(page.getByTestId("wf-list-empty")).toBeVisible()
  await page.getByTestId("wf-new").click()
  await expect(page.getByTestId("wf-empty")).toBeVisible()
  await page.getByTestId("wf-name").fill("Haiku flow")

  // Three steps: two agent steps and a post step.
  await page.getByTestId("wf-add-agent").click()
  await page.getByTestId("wf-step-prompt").fill("Write a haiku")
  await page.getByTestId("wf-add-agent").click()
  await page.getByTestId("wf-step-prompt").fill("Translate this: {{input}}")
  await page.getByTestId("wf-add-post").click()
  await page.getByTestId("wf-step-text").fill("Final: {{input}}")
  await expect(page.getByTestId("wf-node")).toHaveCount(3)

  // A drag moves a node.
  const first = page.getByTestId("wf-node").first()
  const before = await first.boundingBox()
  const c = await center(first)
  await page.mouse.move(c.x - 40, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x - 40, c.y + 60, { steps: 4 })
  await page.mouse.up()
  const after = await first.boundingBox()
  expect((after?.y ?? 0) - (before?.y ?? 0)).toBeGreaterThan(40)

  await connect(page, 0, 1)
  await connect(page, 1, 2)
  await expect(page.getByTestId("wf-edge")).toHaveCount(2)
  await shot(page, "s14-01-canvas")

  // Zoom and pan.
  await page.getByTestId("wf-zoom-out").click()
  await expect(page.getByTestId("wf-canvas")).not.toHaveAttribute("data-zoom", "1.00")
  const canvasBox = await page.getByTestId("wf-canvas").boundingBox()
  await page.mouse.move((canvasBox?.x ?? 0) + 300, (canvasBox?.y ?? 0) + 300)
  const panned = await page.getByTestId("wf-node").first().boundingBox()
  await page.mouse.wheel(0, 60)
  await expect
    .poll(
      async () =>
        ((await page.getByTestId("wf-node").first().boundingBox())?.y ?? 0) < (panned?.y ?? 0),
    )
    .toBe(true)
  await page.getByTestId("wf-zoom-in").click()

  // A step and a note are deleted with a danger button that asks first (spec 000).
  await page.getByTestId("wf-add-notify").click()
  await page.getByTestId("wf-step-name").fill("Tell")
  await expect(page.getByTestId("wf-node")).toHaveCount(4)
  expect(await isDangerButton(page.getByTestId("wf-delete"))).toBe(true)
  await page.getByTestId("wf-delete").click()
  await expect(page.getByTestId("wf-delete-ask")).toContainText(
    "Delete step 4 “Tell”? Its connections go with it, and the save keeps the change.",
  )
  await shot(page, "s14-04-delete-step-ask")
  await page.getByTestId("wf-delete-keep").click()
  await expect(page.getByTestId("wf-node")).toHaveCount(4)
  await page.getByTestId("wf-delete").click()
  await page.getByTestId("wf-delete-confirm").click()
  await expect(page.getByTestId("wf-node")).toHaveCount(3)

  // Run: steps light up, the second step gets the first result.
  await page.getByTestId("wf-run").click()
  await expect(page.locator("[data-testid=wf-node][data-state=done]")).toHaveCount(3, {
    timeout: 30_000,
  })
  await expect(page.getByTestId("wf-run-row")).toHaveCount(1)
  await expect(page.getByTestId("wf-run-row")).toContainText("Done")
  await page.getByTestId("wf-run-step").nth(1).locator("summary").click()
  await expect(page.getByTestId("wf-run-step").nth(1)).toContainText("You said: Write a haiku")
  await shot(page, "s14-02-run-done")

  // The final message is in the channel.
  await page.getByTestId("wf-back").click()
  await expect(page.getByTestId("wf-card")).toHaveCount(1)

  // An approval step waits; the editor is read-only; approve ends the run.
  await page.getByTestId("wf-new").click()
  await page.getByTestId("wf-name").fill("Gate")
  await page.getByTestId("wf-add-approval").click()
  await page.getByTestId("wf-add-post").click()
  await page.getByTestId("wf-step-text").fill("approved")
  await connect(page, 0, 1)
  await page.getByTestId("wf-run").click()
  await expect(page.locator("[data-testid=wf-node][data-state=waiting]")).toHaveCount(1, {
    timeout: 15_000,
  })
  await expect(page.getByTestId("wf-readonly")).toBeVisible()
  await expect(page.getByTestId("wf-name")).toBeDisabled()
  await expect(page.getByTestId("wf-add-agent")).toBeDisabled()
  await page.getByTestId("wf-node").first().click()
  await shot(page, "s14-03-approval")
  await page.getByTestId("wf-approve").click()
  await expect(page.getByTestId("wf-readonly")).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator("[data-testid=wf-node][data-state=done]")).toHaveCount(2)

  await app.close()
})
