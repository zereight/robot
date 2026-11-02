import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow } from "../harness.ts"
import { GOOD_KEY, startMockProvider } from "../mock-provider.ts"
import { freeNearbyPort, freePortPair } from "../ports.ts"

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

const waitForFile = async (file: string, ms: number) => {
  const end = Date.now() + ms
  while (!existsSync(file)) {
    if (Date.now() > end) throw new Error(`no ${file}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

test("a computer for the phone app", async () => {
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
    await createAgent(page, "Ada")
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
    await shot(page, "desktop-02-allow-phone")
    await page.getByTestId("join-allow").click()

    await waitForFile(doneFile, 25 * 60_000)
    const steps = JSON.parse(readFileSync(doneFile, "utf8") || "{}") as { chat?: boolean }
    if (steps.chat) {
      await page
        .getByTestId("settings-close")
        .click()
        .catch(() => undefined)
      await page.keyboard.press("Escape").catch(() => undefined)
      await page.getByText("Ada").first().click()
      await shot(page, "desktop-03-chat-from-phone")
    }
  } finally {
    await app.close()
    await mock.close()
  }
})
