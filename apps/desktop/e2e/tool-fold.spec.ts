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

test("tool steps: a run keeps its place and its open line while the turn makes steps", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // Off: the run folds. Two steps of 1 second each keep the turn going long enough to look at it.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-show-tool-steps").click()
  await expect(page.getByTestId("setting-show-tool-steps")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-close").click()

  // The reply is watched for as long as the turn runs: the rows of its body and its height.
  await page.evaluate(() => {
    const seen: { rows: string; height: number; open: number }[] = []
    const stop = window.setInterval(() => {
      const reply = document.querySelector<HTMLElement>(
        '[data-testid="message"][data-author="agent"]:last-of-type',
      )
      const body = reply?.querySelector<HTMLElement>(":scope > div")
      if (!reply || !body) return
      const entry = {
        rows: [...body.children]
          .map((el) => el.getAttribute("data-testid") ?? el.tagName.toLowerCase())
          .join("<"),
        height: Math.round(reply.getBoundingClientRect().height),
        open: reply.querySelectorAll("[open]").length,
      }
      const last = seen.at(-1)
      if (
        !last ||
        last.rows !== entry.rows ||
        last.height !== entry.height ||
        last.open !== entry.open
      )
        seen.push(entry)
    }, 20)
    ;(window as unknown as { __watch: { seen: typeof seen; stop: number } }).__watch = {
      seen,
      stop,
    }
  })

  await send(
    page,
    `TOOLS ${JSON.stringify([
      { name: "run_command", args: { command: "sleep 1" } },
      { name: "run_command", args: { command: "sleep 1" } },
    ])}`,
  )
  // The first step runs, inside the line of the run: the line opens to show it.
  await expect(page.getByTestId("tools-folded-line")).toBeVisible({ timeout: 20_000 })
  await page.getByTestId("tools-folded-line").click()
  await expect(page.getByTestId("tools-folded")).toHaveAttribute("open", "")
  await settled(page)

  const seen = await page.evaluate(() => {
    const watch = (window as unknown as { __watch: { seen: unknown[]; stop: number } }).__watch
    window.clearInterval(watch.stop)
    return watch.seen as { rows: string; height: number; open: number }[]
  })
  // No card of a step of the run ever stood alone: a card that shows and then goes into the line
  // is what moved the reply on every step of a long turn.
  expect(seen.filter((entry) => entry.rows.endsWith("tool-card")).length).toBe(0)
  // One thought line, and one line of a run, from the first step to the last.
  const rowsAtEnd = seen.at(-1)?.rows ?? ""
  expect(rowsAtEnd.match(/tools-folded/g) ?? []).toHaveLength(1)

  // The line that the user opened is still open, with the two cards in it.
  await expect(page.getByTestId("tools-folded")).toHaveAttribute("open", "")
  await expect(page.locator('[data-testid="tool-card"]:visible')).toHaveCount(2)
  await shot(page, "tool-fold-08-run-keeps-its-line")

  // A change of the theme draws the chat again. The line stays open, because the row of a place is
  // not made again (spec 003).
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-theme").locator('label[data-value="dark"]').click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("tools-folded")).toHaveAttribute("open", "")
  await expect(page.locator('[data-testid="tool-card"]:visible')).toHaveCount(2)
  await shot(page, "tool-fold-09-run-open-dark")
})

test("tool steps: a reply that thinks before every step shows one thought and one run", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const { page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A thinking model takes four steps, and it thinks before each one, as such a model does.
  await send(page, "THINKSTEPS 4")
  await settled(page)
  const reply = page.locator("[data-testid=message][data-author=agent]").last()
  await expect(reply.getByTestId("tool-card")).toHaveCount(4)
  await expect(reply.getByTestId("thinking")).toHaveCount(1)
  await shot(page, "tool-fold-05-thought-cards")

  // Off: the four steps fold as one run, and the thought stays one line above it.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-show-tool-steps").click()
  await expect(page.getByTestId("setting-show-tool-steps")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-close").click()
  await expect(reply.getByTestId("tools-folded-line")).toHaveText("4 tool steps")
  await expect(reply.getByTestId("thinking")).toHaveCount(1)
  await shot(page, "tool-fold-06-thought-folded")

  // The one thought line lists every thought of the turn, in order.
  await reply.getByTestId("thinking").locator("summary").click()
  await expect(reply.getByTestId("thinking").locator("p")).toHaveText(
    "Step 1. Step 2. Step 3. Step 4.",
  )
  await shot(page, "tool-fold-07-thought-open")
})
