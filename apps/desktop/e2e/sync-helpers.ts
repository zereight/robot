import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page } from "@playwright/test"
import {
  connectMock,
  freshUserData,
  type Launched,
  launch,
  resizeWindow,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Two copies of the app run side by side, each with its own data folder, and sync with each other
// over the device link on 127.0.0.1 (spec 016).
export const envFor = (port: number, extra: Record<string, string> = {}) => ({
  ROBOT_SYSTEM_LOCALE: "en-US",
  ROBOT_LINK_ADDRESSES: "127.0.0.1",
  ROBOT_LINK_PORT: String(port),
  ROBOT_LINK_RETRY_MAX_MS: "1000",
  ...extra,
})

const reportsDir = join(shotsDir, "..", "reports")
export const report = (name: string, data: unknown) => {
  mkdirSync(reportsDir, { recursive: true })
  writeFileSync(join(reportsDir, `${name}.json`), JSON.stringify(data, null, 2))
}

export const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
export const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 20_000,
  })

export const openDevices = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-devices").click()
  await expect(page.getByTestId("devices-section")).toBeVisible()
}
export const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("devices-section")).toBeHidden()
}
export const setName = async (page: Page, name: string) => {
  await page.getByTestId("device-name").fill(name)
  await page.getByTestId("device-name").press("Enter")
  await expect(page.getByTestId("device-name")).toHaveValue(name)
}
export const serverRow = (page: Page, name: string) =>
  page.locator(`[data-testid=server-row][data-name="${name}"]`)
export const syncState = (page: Page, name: string) =>
  serverRow(page, name).getByTestId("sync-state")
export const agentNames = async (page: Page) =>
  (await page.locator("[data-testid^=place-agent-]").allInnerTexts())
    .map((t) => t.split("\n")[0]?.trim() ?? "")
    .filter(Boolean)
    .sort()

/** MacBook 2 opens MacBook 1. Settings > Devices is open on both. */
export const link = async (one: Launched, two: Launched, twoWay: boolean) => {
  await one.page.getByTestId("pair-open").click()
  const turnOn = one.page.getByTestId("pair-turn-on")
  if (await turnOn.isVisible().catch(() => false)) await turnOn.click()
  await expect(one.page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
  const code = (await one.page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
  const address =
    (await one.page
      .getByTestId("pair-addresses")
      .locator("li")
      .first()
      .getAttribute("data-address")) ?? ""
  await two.page.getByTestId("connect-open").click()
  await two.page.getByTestId("connect-address").fill(address)
  await two.page.getByTestId("connect-code").fill(code)
  await two.page.getByTestId("connect-next").click()
  await expect(two.page.getByTestId("connect-found")).toBeVisible()
  if (!twoWay) await two.page.getByTestId("connect-two-way").click()
  await two.page.getByTestId("connect-finish").click()
  await one.page.getByTestId("join-allow").click()
  await expect(two.page.getByTestId("connect-dialog")).toBeHidden()
  await one.page.getByTestId("pair-close").click()
  await expect(serverRow(two.page, "MacBook 1").getByTestId("server-row-state")).toHaveAttribute(
    "data-state",
    "online",
    { timeout: 20_000 },
  )
}

/** MacBook 2 asks MacBook 1 to sync; the choice is one of merge, take, send. */
export const startSync = async (two: Launched, mode: "merge" | "take" | "send") => {
  await serverRow(two.page, "MacBook 1").getByTestId("sync-start").click()
  await expect(two.page.getByTestId("sync-start-dialog")).toBeVisible()
  await expect(two.page.getByTestId("sync-there")).toBeVisible({ timeout: 20_000 })
  await two.page.getByTestId(`sync-mode-${mode}-input`).check()
  await two.page.getByTestId("sync-start-confirm").click()
}

export const rpc = <T = unknown>(page: Page, method: string, input?: unknown) =>
  page.evaluate(
    async ([m, i]) => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const result = await (window as any).robot.invoke(m, i)
      if (!result.ok) throw new Error(result.error.code)
      return result.value
    },
    [method, input] as [string, unknown],
  ) as Promise<T>

export const rowOf = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]", { hasText: new RegExp(`^${name}`) })

/** Both computers are linked both ways and synced by a merge. MacBook 1 holds the agents. */
export const synced = async (
  ports: [number, number],
  extra: [Record<string, string>, Record<string, string>] = [{}, {}],
) => {
  const mock = await startMockProvider()
  const data1 = freshUserData()
  const data2 = freshUserData()
  const one = await launch(data1, envFor(ports[0], extra[0]))
  const two = await launch(data2, envFor(ports[1], extra[1]))
  await resizeWindow(one.app, 1200, 860)
  await resizeWindow(two.app, 1200, 860)
  await connectMock(one.page, mock.openaiUrl, GOOD_KEY)
  return { mock, data1, data2, one, two, ports, extra }
}

export const turnOnSync = async (one: Launched, two: Launched, wait = "live") => {
  await openDevices(one.page)
  await setName(one.page, "MacBook 1")
  await openDevices(two.page)
  await setName(two.page, "MacBook 2")
  await link(one, two, true)
  await startSync(two, "merge")
  await one.page.getByTestId("sync-request-allow").click()
  await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", wait, {
    timeout: 60_000,
  })
  await expect(syncState(one.page, "MacBook 2")).toHaveAttribute("data-state", wait, {
    timeout: 60_000,
  })
}
