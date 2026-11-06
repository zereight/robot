import { existsSync, readFileSync } from "node:fs"
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
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import { closeSettings, envFor, openDevices, rpc, setName } from "./sync-helpers.ts"

// The quiet line (specs 005, 003, 004, 015, 011, 012): a turn that shows no sign of life for the
// quiet time reads "No answer from <name> for <time>" in every place that shows it as working. The
// line makes no notification, and the next sign of life ends it. The phone has its own unit test
// against the real link (apps/desktop/src/main/link/phone.test.ts); here a linked computer stands
// for the linked device.

const place = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`).click()
const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const noticesOf = (log: string) => () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { title: string; body: string })
    : []

const QUIET_EN = /^No answer from Mock for (\d+):(\d\d)$/
const QUIET_KO = /^Mock에서 (\d+):(\d\d) 동안 응답이 없어요$/
const secondsOf = (text: string | null, pattern: RegExp) => {
  const m = pattern.exec((text ?? "").trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}

test("a quiet turn reads the quiet line at half of a short limit; the failed row takes its place; no notice", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const log = join(userData, "notices.jsonl")
  const notices = noticesOf(log)
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_NOTIFY_LOG: log,
    ROBOT_TEST_UNFOCUSED: "1",
  })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  // The silent limit is 1 minute: the quiet time is half of it, 30 seconds (spec 005).
  await rpc(page, "settings.update", { silentLimit: 1 })

  await send(page, "go silent please")
  const line = page.getByTestId("working-line")
  await expect(line).toBeVisible()
  const began = Date.now()
  // At first the line is the working line.
  await expect(line).not.toHaveAttribute("data-quiet", "true")
  await expect(page.getByTestId("working-text")).toHaveText("Working…")
  await expect(line.getByTestId("work-mark")).not.toHaveAttribute("data-still", "true")

  // At about 30 seconds the working text becomes the quiet line. The time starts at the quiet time.
  await expect(line).toHaveAttribute("data-quiet", "true", { timeout: 50_000 })
  const waited = Date.now() - began
  expect(waited).toBeGreaterThan(27_000)
  expect(waited).toBeLessThan(42_000)
  const first = await page.getByTestId("working-text").textContent()
  expect(first).toMatch(QUIET_EN)
  expect(secondsOf(first, QUIET_EN)).toBeGreaterThanOrEqual(30)
  expect(secondsOf(first, QUIET_EN)).toBeLessThanOrEqual(36)
  // The light of the badge is still, Stop stays, and the elapsed time of the turn is still there.
  await expect(line.getByTestId("work-mark")).toHaveAttribute("data-still", "true")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await expect(line.locator(":scope > span").nth(2)).toHaveText(/^\d+:\d\d$/)
  // The card of the task in the activity panel of the chat reads the line too.
  await expect(page.getByTestId("activity-task-state")).toHaveText(QUIET_EN)
  await shot(page, "s59-01-short-limit-chat")
  // The time changes once each second.
  await expect
    .poll(async () => secondsOf(await page.getByTestId("working-text").textContent(), QUIET_EN))
    .toBeGreaterThan(secondsOf(first, QUIET_EN))

  // The Tasks page row reads the same line in place of "Running".
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("task-state").first()).toHaveText(QUIET_EN)
  await expect(page.locator("[data-testid=task-row]").first()).toHaveAttribute(
    "data-state",
    "running",
  )
  await shot(page, "s59-02-short-limit-tasks")
  // The line makes no notice.
  expect(notices()).toEqual([])
  await page.getByTestId("page-chats").click()

  // At the silent limit the turn fails as before. The failed row takes the place of the line.
  await expect(page.getByTestId("failed-row")).toBeVisible({ timeout: 45_000 })
  await expect(page.getByTestId("working-line")).toHaveCount(0)
  await expect(page.getByTestId("failed-row")).toContainText("No answer for 1 minute.")
  // One notice, and it is the failure; the quiet line made none.
  await expect.poll(() => notices().length).toBe(1)
  expect(notices()[0]?.body).toContain("go silent")
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("task-state").first()).toHaveText("Failed")
  await app.close()
  await mock.close()
})

const pairOneWay = async (one: Launched, two: Launched) => {
  await openDevices(two.page)
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
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

test("the quiet line shows in the chat, the plan step, the Tasks page, the island and a linked computer; the next sign of life ends it", async () => {
  test.setTimeout(480_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const mock = await startMockProvider()
  const data2 = freshUserData()
  const log = join(data2, "notices.jsonl")
  const notices = noticesOf(log)
  // MacBook 2 runs the agents and has the island. MacBook 1 is the linked computer.
  const two: Launched = await launch(
    data2,
    envFor(PORT_2, {
      ROBOT_TEST_NOTIFY_LOG: log,
      ROBOT_TEST_UNFOCUSED: "1",
      ROBOT_FORCE_ISLAND: "1",
    }),
  )
  const one: Launched = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(two.app, 1300, 860)
    await resizeWindow(one.app, 1300, 860)
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)
    await pairOneWay(one, two)
    await closeSettings(two.page)

    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    for (const name of ["Ada", "Bo"]) await createAgent(two.page, name)
    const servers = await rpc<{ id: string; kind: string }[]>(two.page, "servers.list")
    const serverId = servers.find((s) => s.kind === "local")?.id as string
    const agents = await rpc<{ id: string; name: string }[]>(two.page, "agents.list", {
      serverId,
      archived: false,
    })
    const id = (name: string) => agents.find((a) => a.name === name)?.id as string
    // The silent limit is 5 minutes: the quiet time is 90 seconds (spec 005).
    await rpc(two.page, "settings.update", { silentLimit: 5 })

    // Ada answers a part and then goes quiet. Bo does the same in his own chat.
    await place(two.page, "Ada")
    await send(two.page, "go quiet please")
    await expect(two.page.getByTestId("working-line")).toBeVisible()
    await rpc(two.page, "chat.send", { agentId: id("Bo"), text: "go quiet too", replyTo: null })

    // ---- The chat of MacBook 2 -----------------------------------------------------------
    const lineOf = (page: Page) => page.getByTestId("working-text")
    const began = Date.now()
    await expect(two.page.getByTestId("working-line")).toHaveAttribute("data-quiet", "true", {
      timeout: 150_000,
    })
    const waited = Date.now() - began
    expect(waited).toBeGreaterThan(80_000)
    // The time on the quiet clock starts at the quiet time, 1:30.
    const text = await lineOf(two.page).textContent()
    expect(text).toMatch(QUIET_EN)
    expect(secondsOf(text, QUIET_EN)).toBeGreaterThanOrEqual(90)
    expect(secondsOf(text, QUIET_EN)).toBeLessThanOrEqual(100)
    await expect(two.page.getByTestId("composer-stop")).toBeVisible()
    await expect(two.page.getByTestId("activity-task-state")).toHaveText(QUIET_EN)
    await shot(two.page, "s59-10-chat-quiet-en")

    // ---- No notice ----------------------------------------------------------------------------
    expect(notices()).toEqual([])

    // ---- The Tasks page: both running rows read the line ------------------------------------
    await two.page.getByTestId("page-tasks").click()
    await expect(
      two.page.getByTestId("task-state").filter({ hasText: /^No answer from Mock for / }),
    ).toHaveCount(2, { timeout: 20_000 })
    await shot(two.page, "s59-11-tasks-quiet-en")
    // The detail of a task reads the same line.
    await two.page
      .locator("[data-testid=task-row]", { hasText: "go quiet please" })
      .getByTestId("task-open")
      .click()
    await expect(two.page.getByTestId("task-detail-state")).toHaveText(QUIET_EN)
    await shot(two.page, "s59-12-task-detail-quiet-en")
    await two.page.keyboard.press("Escape")

    // ---- The chat at the tight width ---------------------------------------------------------
    await two.page.getByTestId("page-chats").click()
    await resizeWindow(two.app, 1100, 800)
    // The chat of an agent at the tight width reads the whole line.
    await place(two.page, "Ada")
    await expect(two.page.getByTestId("working-line")).toHaveAttribute("data-quiet", "true")
    await expect(lineOf(two.page)).toHaveText(QUIET_EN)
    // The layout settles after the resize: the line then ends inside the chat view.
    await expect
      .poll(async () => {
        const box = await two.page.getByTestId("working-line").boundingBox()
        const view = await two.page.getByTestId("chat-view").boundingBox()
        return (view?.x ?? 0) + (view?.width ?? 0) - ((box?.x ?? 0) + (box?.width ?? 0))
      })
      .toBeGreaterThanOrEqual(0)
    await shot(two.page, "s59-15-chat-quiet-1100")
    await resizeWindow(two.app, 1300, 860)

    // ---- The island: the rows of both agents read the line -----------------------------------
    const island = await (async () => {
      for (let i = 0; i < 100; i++) {
        const w = two.app.windows().find((x) => x.url().includes("island.html"))
        if (w) return w
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error("no island window")
    })()
    await island.getByTestId("island-bar").hover()
    await expect(island.getByTestId("island-detail")).toBeVisible()
    const row = (name: string) => island.getByTestId("island-row").filter({ hasText: name })
    await expect(row("Ada").getByTestId("island-row-doing")).toHaveText(QUIET_EN)
    await expect(row("Bo").getByTestId("island-row-doing")).toHaveText(QUIET_EN)
    await expect(row("Ada").getByTestId("island-row-doing")).toHaveAttribute("data-quiet", "true")
    await expect(row("Ada")).toHaveAttribute("aria-label", /No answer from Mock for \d+:\d\d/)
    // The time of the row still counts the task; the quiet line counts on, once each second.
    const t1 = secondsOf(await row("Ada").getByTestId("island-row-doing").textContent(), QUIET_EN)
    await expect
      .poll(async () =>
        secondsOf(await row("Ada").getByTestId("island-row-doing").textContent(), QUIET_EN),
      )
      .toBeGreaterThan(t1)
    await island.screenshot({
      path: join(shotsDir, "s59-16-island-quiet-en.png"),
      animations: "disabled",
    })
    await island.mouse.move(3000, 3000)

    // ---- A linked computer: the chat of MacBook 2 on MacBook 1 -------------------------------
    await tile(one.page, "MacBook 2").click()
    await place(one.page, "Ada")
    await expect(one.page.getByTestId("working-line")).toHaveAttribute("data-quiet", "true", {
      timeout: 20_000,
    })
    await expect(lineOf(one.page)).toHaveText(QUIET_EN)
    await expect(one.page.getByTestId("composer-stop")).toBeVisible()
    await shot(one.page, "s59-17-linked-chat-quiet-en")
    // Its Tasks page reads the line too.
    await one.page.getByTestId("page-tasks").click()
    await expect(
      one.page.getByTestId("task-state").filter({ hasText: /^No answer from Mock for / }),
    ).toHaveCount(2, { timeout: 20_000 })
    await one.page.getByTestId("page-chats").click()

    // ---- Korean -----------------------------------------------------------------------------
    await two.page.getByTestId("open-settings").click()
    await two.page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
    await two.page.getByTestId("settings-close").click()
    await expect(lineOf(two.page)).toHaveText(QUIET_KO)
    await shot(two.page, "s59-20-chat-quiet-ko")
    await island.getByTestId("island-bar").hover()
    await expect(island.getByTestId("island-detail")).toBeVisible()
    await expect(
      island.getByTestId("island-row").filter({ hasText: "Ada" }).getByTestId("island-row-doing"),
    ).toHaveText(QUIET_KO)
    await island.screenshot({
      path: join(shotsDir, "s59-22-island-quiet-ko.png"),
      animations: "disabled",
    })
    await island.mouse.move(3000, 3000)
    // Still no notice, after all of this.
    expect(notices()).toEqual([])

    // ---- The next sign of life ends the line at once ----------------------------------------
    await place(two.page, "Ada")
    mock.releaseQuiet()
    await expect(two.page.getByTestId("working-line")).toHaveCount(0, { timeout: 20_000 })
    await expect(two.page.locator("[data-testid=message][data-author=agent]").last()).toContainText(
      "Done after a quiet moment.",
    )
    // MacBook 1 drops the line as well.
    await expect(one.page.getByTestId("working-line")).toHaveCount(0, { timeout: 20_000 })
    await shot(two.page, "s59-23-after-ko")
    // The Tasks page has no quiet line left.
    await two.page.getByTestId("page-tasks").click()
    await expect(
      two.page.getByTestId("task-state").filter({ hasText: /응답이 없어요/ }),
    ).toHaveCount(0)
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
