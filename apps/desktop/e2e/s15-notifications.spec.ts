import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

test("notifications: settings, a notification per kind, the island, Allow on the island", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const log = join(userData, "notices.jsonl")
  const outside = join(userData, "outside")
  mkdirSync(outside, { recursive: true })
  const env = {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_NOTIFY_LOG: log,
    ROBOT_TEST_UNFOCUSED: "1",
    ROBOT_FORCE_ISLAND: "1",
  }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const notices = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { title: string; body: string })
      : []
  const islandPage = async () => {
    for (let i = 0; i < 50; i++) {
      const w = app.windows().find((x) => x.url().includes("island.html"))
      if (w) return w
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error("no island window")
  }

  // A reply while the window has no focus notifies.
  await send(page, "hello")
  await expect.poll(() => notices().length, { timeout: 15_000 }).toBe(1)
  expect(notices()[0]).toMatchObject({ title: "Ada" })

  // Settings: a kind can be turned off, and a server muted.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-notifications").click()
  await expect(page.getByTestId("notifications-section")).toBeVisible()
  await shot(page, "s15-01-settings")
  await page.getByTestId("notify-reply").click()
  await page.getByTestId("settings-close").click()
  await send(page, "hello again")
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
  await page.waitForTimeout(500)
  expect(notices().length).toBe(1)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-notifications").click()
  await page.getByTestId("notify-reply").click()
  await page.getByTestId("mute-server").selectOption("1h")
  await page.getByTestId("settings-close").click()
  await send(page, "hello muted")
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
  await page.waitForTimeout(500)
  expect(notices().length).toBe(1)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-notifications").click()
  await page.getByTestId("mute-server").selectOption("off")
  await page.getByTestId("settings-close").click()

  // An approval: a notification, the island expands, Allow on the island runs the step.
  const victim = join(outside, "victim.txt")
  writeFileSync(victim, "x")
  const before = notices().length
  await send(page, `TOOL run_command ${JSON.stringify({ command: `rm "${victim}"` })}`)
  const island = await islandPage()
  await expect(island.getByTestId("island-attention")).toBeVisible({ timeout: 15_000 })
  await expect(island.getByTestId("island-summary")).toContainText("victim.txt")
  await expect.poll(() => notices().length).toBeGreaterThan(before)
  expect(existsSync(victim)).toBe(true)
  await island.screenshot({ path: join(userData, "island-attention.png") })
  await island.getByTestId("island-allow").click()
  await expect.poll(() => existsSync(victim), { timeout: 15_000 }).toBe(false)
  await expect(island.getByTestId("island-attention")).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId("tool-card").last()).toContainText("Done")

  // Always allow on the island: this step runs, and the same command asks no more. The rule is
  // not wider than the step on the card, so another command still asks (spec 007).
  const second = join(outside, "second.txt")
  const third = join(outside, "third.txt")
  writeFileSync(second, "x")
  writeFileSync(third, "x")
  await send(page, `TOOL run_command ${JSON.stringify({ command: `rm "${second}"` })}`)
  await expect(island.getByTestId("island-attention")).toBeVisible({ timeout: 15_000 })
  await expect(island.getByTestId("island-always")).toBeVisible()
  await island.screenshot({ path: join(userData, "island-attention-always.png") })
  await island.getByTestId("island-always").click()
  await expect.poll(() => existsSync(second), { timeout: 15_000 }).toBe(false)
  await expect(island.getByTestId("island-attention")).toHaveCount(0, { timeout: 10_000 })
  writeFileSync(second, "x")
  await send(page, `TOOL run_command ${JSON.stringify({ command: `rm "${second}"` })}`)
  await expect.poll(() => existsSync(second), { timeout: 15_000 }).toBe(false)
  await expect(island.getByTestId("island-attention")).toHaveCount(0)
  await send(page, `TOOL run_command ${JSON.stringify({ command: `rm "${third}"` })}`)
  await expect(island.getByTestId("island-attention")).toBeVisible({ timeout: 15_000 })
  await expect(island.getByTestId("island-summary")).toContainText("third.txt")
  expect(existsSync(third)).toBe(true)
  await island.getByTestId("island-deny").click()
  await expect(island.getByTestId("island-attention")).toHaveCount(0, { timeout: 10_000 })
  expect(existsSync(third)).toBe(true)

  // Working agents show on the island, then it is idle again.
  await send(page, "please go slow")
  await expect(island.getByTestId("island-working")).toBeVisible({ timeout: 15_000 })
  await expect(island.getByTestId("island-count")).toHaveText("1")
  await page.getByTestId("composer-stop").click()
  await expect(island.getByTestId("island-idle")).toBeVisible({ timeout: 10_000 })
  await app.close()
})
