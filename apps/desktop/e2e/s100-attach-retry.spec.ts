import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  type Launched,
  launch,
  resizeWindow,
  shot,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"

// A file going to a linked server (spec 003, flow 4). One file fails its first transfer. Its chip
// shows Retry. The other file still arrives.

const envFor = (port: number, extra: Record<string, string> = {}) => ({
  ROBOT_SYSTEM_LOCALE: "en-US",
  ROBOT_LINK_ADDRESSES: "127.0.0.1",
  ROBOT_LINK_PORT: String(port),
  ROBOT_LINK_RETRY_MAX_MS: "1000",
  ...extra,
})

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)

const setName = async (page: Page, name: string) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-devices").click()
  await page.getByTestId("device-name").fill(name)
  await page.getByTestId("device-name").press("Enter")
  await expect(page.getByTestId("device-name")).toHaveValue(name)
}

test("a failed file shows Retry, and the other file still goes", async () => {
  test.setTimeout(180_000)
  const [port1, port2] = await freePortPair()
  const mock = await startMockProvider()
  const files = mkdtempSync(join(tmpdir(), "robot-s100-"))
  const good = join(files, "good.txt")
  const bad = join(files, "bad.txt")
  writeFileSync(good, "the notes that go\n")
  writeFileSync(bad, "the notes that fail once\n")

  const two: Launched = await launch(freshUserData(), envFor(port2))
  const one: Launched = await launch(
    freshUserData(),
    envFor(port1, {
      ROBOT_TEST_PICK_FILES: JSON.stringify([good, bad]),
      ROBOT_TEST_FAIL_UPLOAD: "bad.txt",
    }),
  )
  try {
    await resizeWindow(two.app, 1100, 800)
    await resizeWindow(one.app, 1100, 800)
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(two.page, "Ada")
    await setName(two.page, "MacBook 2")
    await two.page.getByTestId("settings-close").click()
    await setName(one.page, "MacBook 1")
    await one.page.getByTestId("settings-close").click()

    await two.page.getByTestId("open-settings").click()
    await two.page.getByTestId("settings-nav-devices").click()
    await two.page.getByTestId("pair-open").click()
    await two.page.getByTestId("pair-turn-on").click()
    await expect(two.page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
    const code = (await two.page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
    const address =
      (await two.page
        .getByTestId("pair-addresses")
        .locator("li")
        .first()
        .getAttribute("data-address")) ?? ""

    await one.page.getByTestId("server-add").click()
    await one.page.getByTestId("connect-address").fill(address)
    await one.page.getByTestId("connect-code").fill(code)
    await one.page.getByTestId("connect-next").click()
    await one.page.getByTestId("connect-two-way").click()
    await one.page.getByTestId("connect-finish").click()
    await two.page.getByTestId("join-allow").click()
    await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
    await two.page.getByTestId("pair-close").click()
    await two.page.getByTestId("settings-close").click()

    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
    await tile(one.page, "MacBook 2").click()
    await one.page.locator("[data-testid^=place-agent-]").first().click()

    await one.page.getByTestId("composer-attach").click()
    await expect(one.page.getByTestId("attachment-chip")).toHaveCount(2)
    await send(one.page, "two files")
    await expect(one.page.getByTestId("attachment-retry")).toBeVisible({ timeout: 15_000 })
    await expect(one.page.getByTestId("attachment-retry")).toHaveText("Retry")
    await expect(one.page.getByTestId("message-file").first()).toContainText("good.txt", {
      timeout: 15_000,
    })
    await expect(one.page.getByTestId("message-file")).toHaveCount(1)
    await shot(one.page, "s100-02-retry-chip")

    await one.page.getByTestId("attachment-retry").click()
    await expect(one.page.getByTestId("message-file").filter({ hasText: "bad.txt" })).toBeVisible({
      timeout: 15_000,
    })
    await expect(one.page.getByTestId("attachment-retry")).toHaveCount(0)
    await shot(one.page, "s100-03-retried")
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
