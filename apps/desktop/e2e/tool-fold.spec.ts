import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

/** The state of a card ("Done") sits inside the card's border, not past its right edge. */
const stateInsideCard = async (card: Locator) => {
  const frame = await card.boundingBox()
  const state = await card.getByText("Done", { exact: true }).boundingBox()
  expect(frame).toBeTruthy()
  expect(state).toBeTruthy()
  if (frame && state) expect(state.x + state.width).toBeLessThanOrEqual(frame.x + frame.width)
}

test("tool steps: the switch folds finished steps into one line", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // Two files in the workspace of the agent: reads there need no question.
  await page.getByTestId("chat-header-agent").click()
  const workspace =
    (await page
      .locator("[data-testid=agent-profile] [data-user-data][title]")
      .first()
      .getAttribute("title")) ?? ""
  expect(workspace).toContain("workspaces")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toBeHidden()
  const first = join(workspace, "first.txt")
  const second = join(workspace, "second.txt")
  writeFileSync(first, "one")
  writeFileSync(second, "two")

  // Two finished steps in one reply show as two cards at first.
  await send(
    page,
    `TOOLS ${JSON.stringify([
      { name: "read_file", args: { path: first } },
      { name: "read_file", args: { path: second } },
    ])}`,
  )
  await settled(page)
  await expect(page.getByTestId("tool-card")).toHaveCount(2)
  await expect(page.getByTestId("tool-card").first()).toContainText("Done")
  for (const card of await page.getByTestId("tool-card").all()) await stateInsideCard(card)
  await expect(page.getByTestId("tools-folded")).toHaveCount(0)
  await shot(page, "tool-fold-01-cards")

  // Off: the run folds into one line, which opens to the cards.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-show-tool-steps").click()
  await expect(page.getByTestId("setting-show-tool-steps")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("tools-folded-line")).toHaveText("2 tool steps")
  await expect(page.locator('[data-testid="tool-card"]:visible')).toHaveCount(0)
  await shot(page, "tool-fold-02-folded")
  await page.getByTestId("tools-folded-line").click()
  await expect(page.locator('[data-testid="tool-card"]:visible')).toHaveCount(2)
  for (const card of await page.getByTestId("tool-card").all()) await stateInsideCard(card)
  await shot(page, "tool-fold-03-open")

  // On again: the cards show with no folded line.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-show-tool-steps").click()
  await expect(page.getByTestId("setting-show-tool-steps")).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("tools-folded")).toHaveCount(0)
  await expect(page.getByTestId("tool-card")).toHaveCount(2)

  // Dark theme: the switch goes off, so the run folds. The folded line is checked in the screenshot.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-theme").locator('label[data-value="dark"]').click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.getByTestId("setting-show-tool-steps").click()
  await expect(page.getByTestId("setting-show-tool-steps")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("tools-folded-line")).toHaveText("2 tool steps")
  await shot(page, "tool-fold-04-dark-folded")
})
