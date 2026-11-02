import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  type Launched,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Two copies of the app run side by side, each with its own data folder, and sync with each other
// over the device link on 127.0.0.1 (spec 016, S21: turn on, first copy, stop).
const envFor = (port: number, extra: Record<string, string> = {}) => ({
  ROBOT_SYSTEM_LOCALE: "en-US",
  ROBOT_LINK_ADDRESSES: "127.0.0.1",
  ROBOT_LINK_PORT: String(port),
  ROBOT_LINK_RETRY_MAX_MS: "1000",
  ...extra,
})

const reportsDir = join(shotsDir, "..", "reports")
const report = (name: string, data: unknown) => {
  mkdirSync(reportsDir, { recursive: true })
  writeFileSync(join(reportsDir, `${name}.json`), JSON.stringify(data, null, 2))
}

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 20_000,
  })

const openDevices = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-devices").click()
  await expect(page.getByTestId("devices-section")).toBeVisible()
}
const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("devices-section")).toBeHidden()
}
const setName = async (page: Page, name: string) => {
  await page.getByTestId("device-name").fill(name)
  await page.getByTestId("device-name").press("Enter")
  await expect(page.getByTestId("device-name")).toHaveValue(name)
}
const serverRow = (page: Page, name: string) =>
  page.locator(`[data-testid=server-row][data-name="${name}"]`)
const syncState = (page: Page, name: string) => serverRow(page, name).getByTestId("sync-state")
const agentNames = async (page: Page) =>
  (await page.locator("[data-testid^=place-agent-]").allInnerTexts())
    .map((t) => t.split("\n")[0]?.trim() ?? "")
    .filter(Boolean)
    .sort()

/** MacBook 2 opens MacBook 1. Settings > Devices is open on both. */
const link = async (one: Launched, two: Launched, twoWay: boolean) => {
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
const startSync = async (two: Launched, mode: "merge" | "take" | "send") => {
  await serverRow(two.page, "MacBook 1").getByTestId("sync-start").click()
  await expect(two.page.getByTestId("sync-start-dialog")).toBeVisible()
  await expect(two.page.getByTestId("sync-there")).toBeVisible({ timeout: 20_000 })
  await two.page.getByTestId(`sync-mode-${mode}-input`).check()
  await two.page.getByTestId("sync-start-confirm").click()
}

test("sync: a new computer takes the data of the other; no secret crosses and agents ask for everything", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const data1 = freshUserData()
  const data2 = freshUserData()
  const one = await launch(data1, envFor(47871))
  const two = await launch(data2, envFor(47872))
  try {
    await resizeWindow(one.app, 1200, 860)
    await resizeWindow(two.app, 1200, 860)

    // MacBook 1 holds two agents and a chat.
    await connectMock(one.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(one.page, "Ada")
    await send(one.page, "Hello from MacBook 1")
    await settled(one.page)
    await createAgent(one.page, "Writer")

    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await link(one, two, false)

    // The sync line is off. The dialog shows what each computer holds and the three choices.
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "off")
    await serverRow(two.page, "MacBook 1").getByTestId("sync-start").click()
    await expect(two.page.getByTestId("sync-there")).toContainText("Agents 2", { timeout: 20_000 })
    await expect(two.page.getByTestId("sync-here")).toContainText("Agents 0")
    await expect(two.page.getByTestId("sync-mode-merge")).toBeVisible()
    await expect(two.page.getByTestId("sync-mode-take")).toContainText(
      "Use the data of MacBook 1 here",
    )
    await expect(two.page.getByTestId("sync-mode-send")).toContainText("Send my data to MacBook 1")
    // The link goes one way, so the dialog says that the other computer can open this one.
    await expect(two.page.getByTestId("sync-one-way")).toContainText(
      "MacBook 1 will also be able to open this computer.",
    )
    await expect(two.page.getByTestId("sync-mode-take-removed")).toContainText(
      "Items removed from this computer: 0",
    )
    await two.page.getByTestId("sync-mode-take-input").check()
    await shot(two.page, "s21-01-start-dialog")
    await two.page.getByTestId("sync-start-confirm").click()

    // MacBook 2 waits. MacBook 1 is asked and sees the lists and the warning.
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "offered")
    await expect(syncState(two.page, "MacBook 1")).toContainText("Waiting for MacBook 1 to allow.")
    await expect(one.page.getByTestId("sync-request-dialog")).toBeVisible()
    await expect(one.page.getByTestId("sync-request-dialog")).toContainText("Sync with MacBook 2?")
    await expect(one.page.getByTestId("sync-request-mode")).toHaveAttribute("data-mode", "take")
    await expect(one.page.getByTestId("sync-request-power")).toContainText(
      "MacBook 2 can change your agents, chats, memory, routines and workflows. You can stop at any time.",
    )
    await expect(one.page.getByTestId("sync-request-dialog")).toContainText("Does not sync")
    await shot(one.page, "s21-02-request-dialog")
    await one.page.getByTestId("sync-request-allow").click()

    // The copy runs and ends with "Up to date".
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "live", {
      timeout: 60_000,
    })
    await expect(syncState(two.page, "MacBook 1")).toContainText("Up to date")
    await expect(syncState(one.page, "MacBook 2")).toHaveAttribute("data-state", "live", {
      timeout: 60_000,
    })
    await shot(two.page, "s21-03-up-to-date")

    // A backup folder exists on both computers.
    for (const dir of [data1, data2]) {
      const backups = existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")) : []
      expect(backups.filter((f) => /^sync-.*\.zip$/.test(f)).length).toBeGreaterThan(0)
    }

    // MacBook 2 shows the same agents and the same chat.
    await closeSettings(two.page)
    await expect.poll(() => agentNames(two.page)).toEqual(["Ada", "Writer"])
    await two.page.locator("[data-testid^=place-agent-]", { hasText: "Ada" }).click()
    await expect(two.page.getByTestId("chat-header-agent")).toContainText("Ada")
    await expect(two.page.getByTestId("message")).toHaveCount(2)
    await expect(two.page.getByTestId("message").first()).toContainText("Hello from MacBook 1")
    await shot(two.page, "s21-04-copy-on-macbook-2")

    // The agent that came uses "Ask for everything", even though the first one could use more.
    await two.page.getByTestId("chat-header-agent").click()
    await expect(
      two.page.getByTestId("agent-permission").locator('label[data-value="ask_all"] input'),
    ).toBeChecked()
    await two.page.keyboard.press("Escape")
    await expect(two.page.getByTestId("agent-profile")).toBeHidden()

    // The model account came by name only. It is not connected here, and no key came along.
    await two.page.getByTestId("open-settings").click()
    await two.page.getByTestId("settings-nav-providers").click()
    await expect(two.page.getByTestId("provider-status")).toHaveText("Not connected")
    await two.page.getByTestId("settings-close").click()
    const secrets2 = `${data2}-secrets.json`
    const stored = existsSync(secrets2) ? readFileSync(secrets2, "utf8") : ""
    expect(stored).not.toContain(GOOD_KEY)
    const dbText = readFileSync(join(data2, "robot.db")).toString("latin1")
    expect(dbText).not.toContain(GOOD_KEY)

    report("s21-take", {
      agentsOnTwo: await agentNames(two.page),
      backupsOne: readdirSync(join(data1, "backups")),
      backupsTwo: readdirSync(join(data2, "backups")),
      keyOnTwo: stored.includes(GOOD_KEY),
    })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})

test("sync: a merge matches names and accounts, a deny and a stop are plain, a new sync makes no copies", async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const one = await launch(freshUserData(), envFor(47873))
  const two = await launch(freshUserData(), envFor(47874))
  try {
    await resizeWindow(one.app, 1200, 860)
    await resizeWindow(two.app, 1200, 860)
    await connectMock(one.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(one.page, "Writer")
    await createAgent(one.page, "Planner")
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(two.page, "Writer")

    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await link(one, two, true)
    // The link goes both ways, so the dialog has no line about the other computer opening this one.
    await serverRow(two.page, "MacBook 1").getByTestId("sync-start").click()
    await expect(two.page.getByTestId("sync-there")).toContainText("Agents 2", { timeout: 20_000 })
    await expect(two.page.getByTestId("sync-one-way")).toHaveCount(0)
    await two.page.getByTestId("sync-start-cancel").click()

    // Deny: MacBook 2 says so in plain words and the row goes back to Off.
    await startSync(two, "merge")
    await expect(one.page.getByTestId("sync-request-mode")).toHaveAttribute("data-mode", "merge")
    await one.page.getByTestId("sync-request-deny").click()
    await expect(two.page.getByTestId("sync-denied")).toContainText(
      "MacBook 1 did not allow the sync.",
    )
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "off")
    await shot(two.page, "s21-05-denied")
    await two.page.getByTestId("sync-dismiss").click()
    await expect(two.page.getByTestId("sync-denied")).toHaveCount(0)

    // Cancel while the other computer waits.
    await startSync(two, "merge")
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "offered")
    await two.page.getByTestId("sync-cancel").click()
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "off")
    await expect(one.page.getByTestId("sync-request-dialog")).toBeHidden({ timeout: 10_000 })

    // Merge: both computers keep their agents and the clashing name gets the origin in brackets.
    await startSync(two, "merge")
    await one.page.getByTestId("sync-request-allow").click()
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "live", {
      timeout: 60_000,
    })
    await expect(syncState(one.page, "MacBook 2")).toHaveAttribute("data-state", "live", {
      timeout: 60_000,
    })
    await closeSettings(two.page)
    await closeSettings(one.page)
    const expected = ["Planner", "Writer", "Writer (MacBook 2)"]
    await expect.poll(() => agentNames(one.page)).toEqual(expected)
    await expect.poll(() => agentNames(two.page)).toEqual(expected)
    await shot(one.page, "s21-06-merged-one")
    await shot(two.page, "s21-07-merged-two")

    // The two model accounts with one name, vendor and address are one account.
    await two.page.getByTestId("open-settings").click()
    await two.page.getByTestId("settings-nav-providers").click()
    await expect(two.page.getByTestId("provider-status")).toHaveCount(1)
    await expect(two.page.getByTestId("provider-status")).toHaveText("Connected")
    await two.page.getByTestId("settings-close").click()

    // Stop: both keep their data. The other computer says who stopped. A change does not cross.
    await openDevices(one.page)
    await syncState(one.page, "MacBook 2").waitFor()
    await serverRow(one.page, "MacBook 2").getByTestId("sync-stop").click()
    await expect(syncState(one.page, "MacBook 2")).toHaveAttribute("data-state", "off")
    await openDevices(two.page)
    await expect(serverRow(two.page, "MacBook 1").getByTestId("sync-stopped-by")).toContainText(
      "MacBook 1 stopped syncing.",
      { timeout: 20_000 },
    )
    await shot(two.page, "s21-08-stopped-by")
    await closeSettings(one.page)
    await createAgent(one.page, "After stop")
    await two.page.waitForTimeout(2500)
    await closeSettings(two.page)
    expect(await agentNames(two.page)).toEqual(expected)
    expect(await agentNames(one.page)).toEqual([...expected, "After stop"].sort())

    // A new sync starts as a merge and makes no copies: the agents that match are the same ones.
    await openDevices(two.page)
    await two.page.getByTestId("sync-dismiss").click()
    await startSync(two, "merge")
    await one.page.getByTestId("sync-request-allow").click()
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "live", {
      timeout: 60_000,
    })
    await closeSettings(two.page)
    await expect.poll(() => agentNames(two.page)).toEqual([...expected, "After stop"].sort())
    await expect.poll(() => agentNames(one.page)).toEqual([...expected, "After stop"].sort())
    report("s21-merge", { agents: await agentNames(two.page) })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})

test("sync: a copy that stops in the middle goes on where it stopped", async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const data1 = freshUserData()
  const data2 = freshUserData()
  const slow = { ROBOT_SYNC_BATCH: "10", ROBOT_SYNC_DELAY_MS: "250" }
  let one = await launch(data1, envFor(47875))
  const two = await launch(data2, envFor(47876))
  try {
    await resizeWindow(one.app, 1200, 860)
    await resizeWindow(two.app, 1200, 860)
    await connectMock(one.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(one.page, "Ada")
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await link(one, two, true)
    await one.app.close()

    // A long history of 400 messages is put into the data of MacBook 1 while the app is closed.
    const db = new DatabaseSync(join(data1, "robot.db"))
    const agentId = (db.prepare("SELECT id FROM agent").get() as { id: string }).id
    const insert = db.prepare(
      "INSERT INTO message (id, agent_id, author, parts, status, created_at, finished_at) VALUES (?, ?, ?, ?, 'done', ?, ?)",
    )
    const start = Date.now() - 1_000_000
    db.exec("BEGIN")
    for (let i = 0; i < 400; i++) {
      insert.run(
        randomUUID(),
        agentId,
        i % 2 === 0 ? "user" : "agent",
        JSON.stringify([{ kind: "text", text: `Message ${i}` }]),
        start + i * 100,
        start + i * 100,
      )
    }
    db.exec("COMMIT")
    db.close()

    one = await launch(data1, envFor(47875, slow))
    await resizeWindow(one.app, 1200, 860)
    await openDevices(one.page)
    await expect(serverRow(two.page, "MacBook 1").getByTestId("server-row-state")).toHaveAttribute(
      "data-state",
      "online",
      { timeout: 30_000 },
    )
    await startSync(two, "take")
    await one.page.getByTestId("sync-request-allow").click()

    // "Copying n of m" grows. Pause holds it, Resume lets it go on.
    const state = syncState(two.page, "MacBook 1")
    await expect(state).toHaveAttribute("data-state", "copying", { timeout: 30_000 })
    await expect(state).toContainText(/Copying [\d,]+ of [\d,]+/)
    await shot(two.page, "s21-09-copying")
    await expect
      .poll(async () => Number((await state.getAttribute("data-done")) ?? 0), { timeout: 30_000 })
      .toBeGreaterThan(20)
    await serverRow(two.page, "MacBook 1").getByTestId("sync-pause").click()
    await expect(state).toHaveAttribute("data-state", "paused")
    const held = Number(await state.getAttribute("data-done"))
    await two.page.waitForTimeout(1500)
    expect(Number(await state.getAttribute("data-done"))).toBe(held)
    await serverRow(two.page, "MacBook 1").getByTestId("sync-resume").click()
    await expect(state).toHaveAttribute("data-state", "copying", { timeout: 20_000 })
    await expect
      .poll(async () => Number((await state.getAttribute("data-done")) ?? 0), { timeout: 30_000 })
      .toBeGreaterThan(held + 30)

    // MacBook 1 stops in the middle of the copy.
    const before = Number(await state.getAttribute("data-done"))
    const total = Number(await state.getAttribute("data-total"))
    expect(before).toBeLessThan(total)
    await one.app.close()
    one = await launch(data1, envFor(47875, slow))
    await resizeWindow(one.app, 1200, 860)

    // The copy goes on. It does not start over: the count never falls back near zero.
    let lowest = Number.POSITIVE_INFINITY
    const end = Date.now() + 120_000
    for (;;) {
      const s = await state.getAttribute("data-state")
      const d = Number((await state.getAttribute("data-done")) ?? 0)
      if (s === "copying" && d > 0) lowest = Math.min(lowest, d)
      if (s === "live") break
      expect(Date.now()).toBeLessThan(end)
      await two.page.waitForTimeout(100)
    }
    expect(lowest).toBeGreaterThan(before - 60)
    await closeSettings(two.page)
    await two.page.locator("[data-testid^=place-agent-]", { hasText: "Ada" }).click()
    await expect(two.page.getByTestId("chat-header-agent")).toContainText("Ada")
    await expect(two.page.getByText("Message 399")).toBeVisible({ timeout: 20_000 })
    report("s21-resume", { before, total, lowestAfterRestart: lowest })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
