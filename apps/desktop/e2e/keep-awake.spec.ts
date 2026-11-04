import { execFileSync } from "node:child_process"
import { type ElectronApplication, expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

/**
 * True when the system holds the computer awake for the app (macOS). The system lists each hold
 * with the number of the program that made it, so this is the real effect, not a flag of the app.
 * A hold that stops the computer from sleeping shows as "NoIdleSleepAssertion".
 */
const systemHolds = async (app: ElectronApplication) => {
  if (process.platform !== "darwin") return undefined
  const pid = await app.evaluate(() => process.pid)
  const out = execFileSync("pmset", ["-g", "assertions"], { encoding: "utf8" })
  return out
    .split("\n")
    .some((line) => line.includes(`pid ${pid}(`) && line.includes("NoIdleSleepAssertion"))
}

const openGeneral = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await expect(page.getByTestId("setting-keep-awake")).toBeVisible()
}

const choice = (page: Page, value: "off" | "working" | "routines") =>
  page.getByTestId("setting-keep-awake").locator(`label[data-value="${value}"]`)

test("keep awake: held while an agent works, let go when the work ends, and off holds nothing", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_ON_BATTERY: "0",
  })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // First start: the setting holds the computer while an agent works, and nothing works now.
  await openGeneral(page)
  await expect(choice(page, "working").locator("input")).toBeChecked()
  await expect(choice(page, "off")).toHaveText("Off")
  await expect(choice(page, "working")).toHaveText("While agents work")
  await expect(choice(page, "routines")).toHaveText("Also for routines")
  await expect(page.getByTestId("setting-keep-awake-state")).toHaveText(
    "The app does not hold the computer awake now.",
  )
  expect(await systemHolds(app)).not.toBe(true)
  await shot(page, "keep-awake-01-setting")
  await page.getByTestId("settings-close").click()

  // An agent works: the app holds the computer, and the line in settings says so. The mock waits
  // 6 seconds before it answers.
  await send(page, "hello pause 6000ms")
  await expect(page.getByTestId("composer-stop")).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => systemHolds(app), { timeout: 5_000 }).not.toBe(false)
  await openGeneral(page)
  await expect(page.getByTestId("setting-keep-awake-state")).toHaveText(
    "Awake now. Agents that work: 1.",
  )
  await shot(page, "keep-awake-02-working")

  // Off lets go at once, while the agent still works.
  await choice(page, "off").click()
  await expect(page.getByTestId("setting-keep-awake-state")).toHaveText(
    "The app does not hold the computer awake now.",
  )
  await expect.poll(() => systemHolds(app), { timeout: 5_000 }).not.toBe(true)
  // On again while the agent still works: it holds again.
  await choice(page, "working").click()
  await expect(page.getByTestId("setting-keep-awake-state")).toHaveText(
    "Awake now. Agents that work: 1.",
  )
  await expect.poll(() => systemHolds(app), { timeout: 5_000 }).not.toBe(false)

  // The work ends: the hold ends with it.
  await page.getByTestId("settings-close").click()
  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("composer-stop")).toHaveCount(0, { timeout: 10_000 })
  await expect.poll(() => systemHolds(app), { timeout: 5_000 }).not.toBe(true)
  await openGeneral(page)
  await expect(page.getByTestId("setting-keep-awake-state")).toHaveText(
    "The app does not hold the computer awake now.",
  )

  // The choice stays after a restart of the window.
  await choice(page, "routines").click()
  await page.reload()
  await openGeneral(page)
  await expect(choice(page, "routines").locator("input")).toBeChecked()
  await app.close()
  await mock.close()
})

const makeRoutine = async (page: Page) => {
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("Morning check")
  await page.getByTestId("routine-prompt").fill("Say good morning")
  await page.getByTestId("routine-kind").selectOption("daily")
  await page.getByTestId("routine-times").fill("09:00")
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(1)
}

test("keep awake: a routine that is on holds the computer on power, and lets go on battery", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const data = freshUserData()

  // On power.
  const onPower = await launch(data, { ROBOT_SYSTEM_LOCALE: "en-US", ROBOT_TEST_ON_BATTERY: "0" })
  await resizeWindow(onPower.app, 1300, 860)
  await connectMock(onPower.page, mock.openaiUrl, GOOD_KEY)
  await createAgent(onPower.page, "Ada")
  await makeRoutine(onPower.page)
  // The default does not hold for a routine that only waits.
  expect(await systemHolds(onPower.app)).not.toBe(true)
  await openGeneral(onPower.page)
  await choice(onPower.page, "routines").click()
  await expect(onPower.page.getByTestId("setting-keep-awake-state")).toHaveText(
    "Awake now. Routines that are on: 1.",
  )
  await expect.poll(() => systemHolds(onPower.app), { timeout: 5_000 }).not.toBe(false)
  await shot(onPower.page, "keep-awake-03-routines")
  await onPower.app.close()

  // The same data on its battery: the routine does not hold the computer, and the line says why.
  const onBattery = await launch(data, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_ON_BATTERY: "1",
  })
  await resizeWindow(onBattery.app, 1300, 860)
  await openGeneral(onBattery.page)
  await expect(choice(onBattery.page, "routines").locator("input")).toBeChecked()
  await expect(onBattery.page.getByTestId("setting-keep-awake-state")).toHaveText(
    "The computer runs on its battery. A routine that waits does not hold it awake.",
  )
  expect(await systemHolds(onBattery.app)).not.toBe(true)
  await onBattery.app.close()
  await mock.close()
})
