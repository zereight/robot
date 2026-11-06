import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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

// MacBook 1 opens an agent of MacBook 2. Two copies of the app run side by side, each with its own
// data folder, and find each other on 127.0.0.1.

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
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
const userMessages = (page: Page) => page.locator("[data-testid=message][data-author=user]")
const agentMessages = (page: Page) => page.locator("[data-testid=message][data-author=agent]")
const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)

const setName = async (page: Page, name: string) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-devices").click()
  await page.getByTestId("device-name").fill(name)
  await page.getByTestId("device-name").press("Enter")
  await expect(page.getByTestId("device-name")).toHaveValue(name)
}

test("linked server: an agent of another computer works in this window, offline shows the cache", async () => {
  test.setTimeout(240_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const mock = await startMockProvider()
  const data1 = freshUserData()
  const data2 = freshUserData()
  const files = mkdtempSync(join(tmpdir(), "robot-s19-"))
  const upload = join(files, "notes.txt")
  writeFileSync(upload, "notes for Ada\n")
  const saved = join(files, "saved-notes.txt")

  // MacBook 2 has the agent. MacBook 1 only opens it.
  let two: Launched = await launch(data2, envFor(PORT_2))
  const one: Launched = await launch(
    data1,
    envFor(PORT_1, {
      ROBOT_TEST_PICK_FILES: JSON.stringify([upload]),
      ROBOT_TEST_SAVE_PATH: saved,
    }),
  )
  try {
    await resizeWindow(two.app, 1200, 860)
    await resizeWindow(one.app, 1200, 860)
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(two.page, "Ada")
    await setName(two.page, "MacBook 2")
    await two.page.getByTestId("settings-close").click()
    await setName(one.page, "MacBook 1")
    await one.page.getByTestId("settings-close").click()

    // Pair: MacBook 2 shows the code, MacBook 1 connects with the address and the code.
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
    await one.page.getByTestId("connect-two-way").click() // one way is enough here
    await one.page.getByTestId("connect-finish").click()
    // This test is about a client without the switch "Can create and change agents" (012).
    await two.page.getByTestId("join-can-change").click()
    await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "false")
    await two.page.getByTestId("join-allow").click()
    await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
    await two.page.getByTestId("pair-close").click()
    await two.page.getByTestId("settings-close").click()

    // MacBook 1 shows a tile for MacBook 2; it is online.
    await expect(tile(one.page, "MacBook 2")).toBeVisible()
    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
    await tile(one.page, "MacBook 2").click()
    await expect(one.page.locator("[data-testid^=place-agent-]")).toHaveCount(1)
    await one.page.locator("[data-testid^=place-agent-]").first().click()
    await expect(one.page.getByTestId("chat-header-agent")).toContainText("Ada")
    // A client sees the agent but cannot edit it, and cannot create agents.
    await expect(one.page.getByTestId("chat-header-agent")).toHaveAttribute("data-readonly", "true")
    await expect(one.page.getByTestId("new-agent")).toHaveCount(0)
    await shot(one.page, "s19-01-linked-server")

    // The profile opens as text only, with the line that says where to turn the switch on.
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-profile-view")).toBeVisible()
    await expect(one.page.getByTestId("agent-view-name")).toHaveText("Ada")
    await expect(one.page.getByTestId("agent-form")).toHaveCount(0)
    await expect(one.page.getByTestId("agent-submit")).toHaveCount(0)
    await expect(one.page.getByTestId("agent-archive")).toHaveCount(0)
    await expect(one.page.getByTestId("agent-readonly-hint")).toContainText(
      "MacBook 2 does not let this device change agents. Turn it on in Settings → Devices on that computer.",
    )
    await expect(one.page.getByTestId("agent-workspace-on")).toHaveText("Workspace: on MacBook 2")
    await shot(one.page, "s19-01b-read-only-profile")
    await one.page.getByTestId("agent-view-close").click()
    await expect(one.page.getByTestId("agent-profile")).toBeHidden()

    // Send from MacBook 1: the reply streams in both windows.
    await send(one.page, "hello from the laptop")
    await expect(agentMessages(one.page).first()).toContainText("You said: hello from the laptop", {
      timeout: 15_000,
    })
    await settled(one.page)
    await two.page.locator("[data-testid^=place-agent-]").first().click()
    await expect(agentMessages(two.page).first()).toContainText("You said: hello from the laptop", {
      timeout: 15_000,
    })
    await settled(two.page)
    // MacBook 2 names the device that sent it. MacBook 1 does not name itself.
    await expect(userMessages(two.page).first().getByTestId("from-device")).toHaveText(
      "from MacBook 1",
    )
    await expect(userMessages(one.page).first().getByTestId("from-device")).toHaveCount(0)
    await shot(two.page, "s19-02-from-device")

    // The reply of the agent is streaming live in both windows: send again and watch both.
    await send(one.page, "second message")
    await expect(agentMessages(two.page)).toHaveCount(2, { timeout: 15_000 })
    await expect(agentMessages(one.page)).toHaveCount(2, { timeout: 15_000 })
    await settled(one.page)

    // Attach a file from MacBook 1, then download it again from the message.
    await one.page.getByTestId("composer-attach").click()
    await expect(one.page.getByTestId("attachment-chip")).toContainText("notes.txt")
    await send(one.page, "here are my notes")
    await expect(one.page.getByTestId("message-file").first()).toContainText("notes.txt", {
      timeout: 15_000,
    })
    await settled(one.page)
    await expect(two.page.getByTestId("message-file").first()).toContainText("notes.txt", {
      timeout: 15_000,
    })
    await one.page.getByTestId("message-file-download").first().click()
    await expect(one.page.getByTestId("message-file-saved")).toBeVisible({ timeout: 15_000 })
    expect(readFileSync(saved, "utf8")).toBe("notes for Ada\n")
    await shot(one.page, "s19-03-file")

    // What a client cannot do shows a muted line: the routines of the server and the usage page.
    // The workflows of the server open on a client (see s56).
    await one.page.getByTestId("page-routines").click()
    await expect(one.page.getByTestId("page-open-on-server")).toHaveText("Open this on MacBook 2.")
    await one.page.getByTestId("page-usage").click()
    await expect(one.page.getByTestId("page-open-on-server")).toBeVisible()
    await shot(one.page, "s19-04-open-on-server")
    await one.page.getByTestId("page-chats").click()

    // Quit MacBook 2: the tile goes to Offline, the last messages stay, the message box is off.
    const countBefore = await userMessages(one.page).count()
    await two.app.close()
    await expect(tile(one.page, "MacBook 2")).toHaveAttribute(
      "data-state",
      /offline|reconnecting/,
      { timeout: 30_000 },
    )
    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "offline", {
      timeout: 60_000,
    })
    await expect(one.page.getByTestId("server-notice")).toContainText("Offline")
    await expect(userMessages(one.page)).toHaveCount(countBefore)
    await expect(one.page.getByTestId("composer-offline")).toHaveText("MacBook 2 is offline.")
    await expect(one.page.getByTestId("composer-input")).toHaveCount(0)
    await shot(one.page, "s19-05-offline")
    // The cache holds the places of the server too: it still lists the agent.
    await expect(one.page.locator("[data-testid^=place-agent-]")).toHaveCount(1)

    // Start MacBook 2 again: the tile goes to Online with no new pairing.
    two = await launch(data2, envFor(PORT_2))
    await resizeWindow(two.app, 1200, 860)
    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online", {
      timeout: 60_000,
    })
    await expect(one.page.getByTestId("composer-input")).toBeVisible()
    await send(one.page, "back again")
    await expect(agentMessages(one.page).last()).toContainText("You said: back again", {
      timeout: 15_000,
    })
    await settled(one.page)
    await shot(one.page, "s19-06-back-online")

    // "Remove" from the menu of the tile: the link ends and the tile goes.
    await tile(one.page, "MacBook 2").click({ button: "right" })
    await one.page.getByTestId("server-tile-remove").click()
    await expect(tile(one.page, "MacBook 2")).toHaveCount(0)
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
