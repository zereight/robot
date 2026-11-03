import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow } from "../harness.ts"
import { GOOD_KEY, startMockProvider } from "../mock-provider.ts"
import { freeNearbyPort, freePortPair } from "../ports.ts"

// The computer of the end-to-end run of the phone app that has a channel (the `@` list of the
// message box, spec 004). It is the host of phone-host.ts with three agents and one channel.
//
// The computer of the end-to-end run of the phone app (apps/mobile/e2e/run-ios.ts). It is not a
// spec of the desktop: the file name keeps it out of `bun run e2e` and CI. It starts the desktop
// with its own data folder, a mock model and one agent, shows a pairing code on 127.0.0.1, and
// allows the phone when it asks. The phone side writes `done` when its steps have ended.

const dir = resolve(
  process.env.PHONE_E2E_DIR ?? resolve(import.meta.dirname, "../../../../build/e2e/phone"),
)
const hostFile = join(dir, "host.json")
const doneFile = join(dir, "done")

const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${name}.png`) })

test("a computer for the phone app, with a channel", async () => {
  test.setTimeout(30 * 60_000)
  mkdirSync(dir, { recursive: true })
  const [port] = await freePortPair()
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_LINK_ADDRESSES: "127.0.0.1",
    ROBOT_LINK_PORT: String(port),
    ROBOT_LINK_NEARBY_PORT: String(await freeNearbyPort()),
  })
  try {
    await resizeWindow(app, 1200, 860)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    for (const name of ["Lia", "Bo", "Cy"]) await createAgent(page, name)
    await page.getByTestId("new-channel").click()
    await page.getByTestId("channel-name").fill("Launch")
    for (const name of ["Lia", "Bo", "Cy"]) await page.getByTestId(`channel-member-${name}`).check()
    await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
    await page.getByTestId("channel-submit").click()
    await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-devices").click()
    await page.getByTestId("device-name").fill("MacBook")
    await page.getByTestId("device-name").press("Enter")
    await page.getByTestId("pair-open").click()
    const turnOn = page.getByTestId("pair-turn-on")
    if (await turnOn.isVisible().catch(() => false)) await turnOn.click()
    await expect(page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
    const code = (await page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
    writeFileSync(hostFile, JSON.stringify({ address: `127.0.0.1:${port}`, code }))
    await shot(page, "desktop-01-pairing-code")

    // The phone asks: "Allow <phone name>?" with the kind phone and no two-way choice.
    await expect(page.getByTestId("join-dialog")).toBeVisible({ timeout: 10 * 60_000 })
    // Phone 1 has no screens to change agents, so the switch is off at first for a phone.
    await expect(page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "false")
    await shot(page, "desktop-02-allow-phone")
    await page.getByTestId("join-allow").click()
    await expect(page.getByTestId("pair-ended")).toBeVisible()
    await page.getByTestId("pair-close").click()
    // The list of devices that can open this computer shows the phone.
    await expect(page.locator('[data-testid=client-row][data-name="iPhone of Kim"]')).toBeVisible()
    await shot(page, "desktop-03-devices")

    // The channel stays open, so the window shows what the phone sends. The run ends when the
    // phone side writes `done`.
    await page.getByTestId("settings-close").click()
    await expect(page.getByTestId("settings")).toBeHidden()
    await page.locator('[data-testid^="place-channel-"]').first().click()
    while (!existsSync(doneFile)) await page.waitForTimeout(500)
    await shot(page, "desktop-04-channel-from-phone")
  } finally {
    await app.close()
    await mock.close()
  }
})
