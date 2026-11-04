import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ElectronApplication } from "@playwright/test"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  launch,
  resizeWindow,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

interface Named {
  id: string
  name: string
}

const ISLAND_ENV = {
  ROBOT_TEST_UNFOCUSED: "1",
  ROBOT_FORCE_ISLAND: "1",
}

/** Calls the main process from the app window, as the window itself does. */
const rpc = <T>(page: Page, method: string, input?: unknown): Promise<T> =>
  page.evaluate(
    async ([m, i]) => {
      const bridge = (
        window as unknown as {
          robot: {
            invoke: (
              method: string,
              input: unknown,
            ) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>
          }
        }
      ).robot
      const result = await bridge.invoke(m as string, i)
      if (!result.ok) throw new Error(JSON.stringify(result.error))
      return result.value
    },
    [method, input] as const,
  ) as Promise<T>

const islandPage = async (app: ElectronApplication) => {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((x) => x.url().includes("island.html"))
    if (w) return w
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("no island window")
}

const islandWindow = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === "ROBot island")
    if (!w) return null
    const display = screen.getPrimaryDisplay().bounds
    return { ...w.getBounds(), visible: w.isVisible(), screenCenter: display.x + display.width / 2 }
  })

/** Whether the island page needs a scroll bar. It must never. */
const scrolls = (island: Page) =>
  island.evaluate(() => {
    const el = document.documentElement
    return el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth
  })

/** The window takes the size of the content of the island page. */
const expectFitted = async (app: ElectronApplication, island: Page) => {
  await expect
    .poll(
      async () => {
        const box = await island.locator(".island").boundingBox()
        const win = await islandWindow(app)
        if (!box || !win) return false
        return (
          win.width === Math.ceil(box.width) &&
          win.height >= Math.ceil(box.height) &&
          // The window is the height of the content, or of the camera notch when that is taller.
          win.height - Math.ceil(box.height) < 60 &&
          Math.abs(win.x + win.width / 2 - win.screenCenter) <= 1
        )
      },
      { timeout: 5000 },
    )
    .toBe(true)
  expect(await scrolls(island)).toBe(false)
}

/** A screenshot of the island page, with the motion shown at its end. */
const snap = (island: Page, name: string) =>
  island.screenshot({ path: join(shotsDir, name), animations: "disabled" })

const seconds = (text: string | null) => {
  const parts = (text ?? "").trim().split(":").map(Number)
  return parts.reduce((total, part) => total * 60 + part, 0)
}

const setup = async (env: Record<string, string> = {}) => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  const log = join(userData, "notices.jsonl")
  // A short path, so that the card holds the file name when it cuts the line to 90 characters.
  // Windows has no /tmp; its temporary folder is short enough on the runners.
  const outside = mkdtempSync(process.platform === "win32" ? join(tmpdir(), "s33-") : "/tmp/s33-")
  const launched = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_NOTIFY_LOG: log,
    ...ISLAND_ENV,
    ...env,
  })
  await resizeWindow(launched.app, 1300, 860)
  await connectMock(launched.page, mock.openaiUrl, GOOD_KEY)
  const notices = () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []
  const victim = (name: string) => {
    const path = join(outside, `${name}.txt`)
    writeFileSync(path, "x")
    return path
  }
  return { ...launched, notices, victim, outside }
}

const agentsOf = async (page: Page) => {
  const servers = await rpc<Named[]>(page, "servers.list")
  const serverId = servers[0]?.id as string
  const agents = await rpc<Named[]>(page, "agents.list", { serverId, archived: false })
  return {
    serverId,
    id: (name: string) => {
      const found = agents.find((a) => a.name === name)
      if (!found) throw new Error(`no agent ${name}`)
      return found.id
    },
  }
}

const sendTo = (page: Page, agentId: string, text: string) =>
  rpc(page, "chat.send", { agentId, text, replyTo: null })

test("island detail card: rows, place, what the agent does, time, size, closing, more", async () => {
  test.setTimeout(180_000)
  mkdirSync(shotsDir, { recursive: true })
  const { app, page } = await setup()
  for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)
  const { serverId, id } = await agentsOf(page)
  const channel = await rpc<Named>(page, "channels.create", {
    serverId,
    name: "Launch",
    topic: "",
    memberIds: [id("Bo")],
    leadId: null,
  })
  const island = await islandPage(app)

  // Idle: no card, even when the pointer is on the island.
  await expect(island.getByTestId("island-idle")).toBeVisible({ timeout: 15_000 })
  await expect(island.getByTestId("island-bar").getByTestId("app-mark")).toBeVisible()
  await island.getByTestId("island-bar").hover()
  await expect(island.getByTestId("island-detail")).toHaveCount(0)
  await expect(island.getByTestId("island-bar")).toHaveAttribute("aria-label", "ROBot")
  await island.mouse.move(3000, 3000)

  // Three agents work: one in a direct chat, one on a command, one in a channel.
  await sendTo(page, id("Ada"), "run long")
  await sendTo(page, id("Cy"), 'TOOL run_command {"command":"sleep 40 && echo SECRET-CMD"}')
  await rpc(page, "channels.send", { channelId: channel.id, text: "@Bo run long" })
  await expect(island.getByTestId("island-count")).toHaveText("3", { timeout: 20_000 })
  await expect(island.getByTestId("island-bar")).toHaveAttribute("aria-label", "Agents working: 3")
  await expect(island.getByTestId("island-detail")).toHaveCount(0)
  const barWindow = await islandWindow(app)
  await expectFitted(app, island)

  // Pointing at the island opens the card.
  await island.getByTestId("island-bar").hover()
  await expect(island.getByTestId("island-detail")).toBeVisible()
  await expect(island.getByTestId("island-bar")).toHaveAttribute("aria-expanded", "true")
  const rows = island.getByTestId("island-row")
  await expect(rows).toHaveCount(3)
  const row = (name: string) => rows.filter({ hasText: name })
  await expect(row("Ada").getByTestId("island-row-place")).toHaveText("Direct chat")
  await expect(row("Ada").getByTestId("island-row-doing")).toHaveText("Working…")
  await expect(row("Cy").getByTestId("island-row-place")).toHaveText("Direct chat")
  await expect(row("Cy").getByTestId("island-row-doing")).toHaveText("Running a command")
  await expect(row("Bo").getByTestId("island-row-place")).toHaveText("#Launch")
  await expect(row("Bo").getByTestId("island-row-doing")).toHaveText("Working…")
  await expect(row("Cy")).toHaveAttribute(
    "aria-label",
    /^Cy, Direct chat, Running a command, \d+:\d\d\. Open this place\.$/,
  )
  for (const name of ["Ada", "Bo", "Cy"])
    await expect(row(name).getByTestId("island-row-time")).toHaveText(/^\d+:\d\d$/)
  // The row never shows the command, a path, or file content.
  const html = await island.content()
  expect(html).not.toContain("SECRET-CMD")
  expect(html).not.toContain("sleep")
  await snap(island, "s33-01-detail.png")

  // The window grows to the card and keeps it without a scroll bar.
  await expectFitted(app, island)
  const cardWindow = await islandWindow(app)
  expect(cardWindow?.height).toBeGreaterThan(barWindow?.height ?? 0)

  // The time counts up once each second while the card is open.
  const time = row("Ada").getByTestId("island-row-time")
  const first = seconds(await time.textContent())
  await expect
    .poll(async () => seconds(await time.textContent()), { timeout: 6000 })
    .toBeGreaterThan(first + 1)

  // The card closes 400 ms after the pointer has left. A pointer that comes back in time keeps it.
  await island.mouse.move(3000, 3000)
  await island.waitForTimeout(150)
  await expect(island.getByTestId("island-detail")).toBeVisible()
  await island.getByTestId("island-bar").hover()
  await island.waitForTimeout(700)
  await expect(island.getByTestId("island-detail")).toBeVisible()
  await island.mouse.move(3000, 3000)
  await expect(island.getByTestId("island-detail")).toHaveCount(0, { timeout: 3000 })
  await expect.poll(async () => (await islandWindow(app))?.height).toBe(barWindow?.height)

  // A click on the bar closes the card, and it stays closed until the pointer comes back.
  await island.getByTestId("island-bar").hover()
  await expect(island.getByTestId("island-detail")).toBeVisible()
  await island.getByTestId("island-bar").click()
  await expect(island.getByTestId("island-detail")).toHaveCount(0)
  await island.waitForTimeout(600)
  await expect(island.getByTestId("island-detail")).toHaveCount(0)
  await island.mouse.move(3000, 3000)
  await island.getByTestId("island-bar").hover()
  await expect(island.getByTestId("island-detail")).toBeVisible()

  // A click on a row opens the place of that agent.
  await row("Cy").click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Cy")
  await island.mouse.move(3000, 3000)
  await island.getByTestId("island-bar").hover()
  await row("Bo").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")

  // Seven agents work: five rows and a line for the two more.
  for (const name of ["Di", "Ed", "Flo", "Gus"]) await createAgent(page, name)
  const more = await agentsOf(page)
  for (const name of ["Di", "Ed", "Flo", "Gus"])
    await sendTo(page, more.id(name), 'TOOL run_command {"command":"sleep 40"}')
  await expect(island.getByTestId("island-count")).toHaveText("7", { timeout: 30_000 })
  await island.mouse.move(3000, 3000)
  await island.getByTestId("island-bar").hover()
  await expect(rows).toHaveCount(5)
  await expect(island.getByTestId("island-more")).toHaveText("2 more")
  await expectFitted(app, island)
  await snap(island, "s33-02-more.png")

  // Stopped agents leave the card; with none left the island is idle.
  for (const name of ["Ada", "Cy", "Di", "Ed", "Flo", "Gus"])
    await rpc(page, "chat.stop", { agentId: more.id(name) })
  await rpc(page, "channels.stop", { channelId: channel.id })
  await expect(island.getByTestId("island-idle")).toBeVisible({ timeout: 20_000 })
  await expect(island.getByTestId("island-detail")).toHaveCount(0)
  await app.close()
})

test("island plan step: the row shows the label of the plan step that runs", async () => {
  test.setTimeout(120_000)
  const { app, page } = await setup()
  for (const name of ["Lia", "Bo"]) await createAgent(page, name)
  const { serverId, id } = await agentsOf(page)
  const channel = await rpc<Named>(page, "channels.create", {
    serverId,
    name: "Launch",
    topic: "",
    memberIds: [id("Lia"), id("Bo")],
    leadId: id("Lia"),
  })
  const island = await islandPage(app)
  await rpc(page, "channels.send", { channelId: channel.id, text: "split hold" })
  await expect(island.getByTestId("island-count")).toHaveText("2", { timeout: 30_000 })
  await island.getByTestId("island-bar").hover()
  const rows = island.getByTestId("island-row")
  await expect(rows).toHaveCount(2)
  const bo = rows.filter({ hasText: "Bo" })
  await expect(bo.getByTestId("island-row-doing")).toHaveText("Hold the line")
  await expect(bo.getByTestId("island-row-place")).toHaveText("#Launch")
  await rpc(page, "channels.stop", { channelId: channel.id })
  await app.close()
})

test("island attention card: place, kind of step, 1 of N, previous and next, answer", async () => {
  test.setTimeout(150_000)
  mkdirSync(shotsDir, { recursive: true })
  const { app, page, notices, victim } = await setup()
  for (const name of ["Ada", "Bo", "Cy", "Dee"]) await createAgent(page, name)
  const { serverId, id } = await agentsOf(page)
  const channel = await rpc<Named>(page, "channels.create", {
    serverId,
    name: "Launch",
    topic: "",
    memberIds: [id("Cy")],
    leadId: null,
  })
  const island = await islandPage(app)
  const attention = island.getByTestId("island-attention")
  const position = island.getByTestId("island-position")
  const summary = island.getByTestId("island-summary")
  const rm = (path: string) => `TOOL run_command ${JSON.stringify({ command: `rm "${path}"` })}`
  const paths = { Ada: victim("a-first"), Bo: victim("b-second"), Cy: victim("c-third") }

  // Three requests wait, oldest first: a direct chat, a direct chat, and a channel.
  await sendTo(page, id("Ada"), rm(paths.Ada))
  await expect(attention).toBeVisible({ timeout: 20_000 })
  await expect(position).toHaveCount(0)
  await expect(island.getByTestId("island-meta")).toHaveText("Direct chat · Command")
  await sendTo(page, id("Bo"), rm(paths.Bo))
  await expect(position).toHaveText("1 of 2")
  await rpc(page, "channels.send", { channelId: channel.id, text: `@Cy ${rm(paths.Cy)}` })
  await expect(position).toHaveText("1 of 3")
  await expect(position).toHaveAttribute("aria-label", "Request 1 of 3")
  await expect(summary).toContainText("a-first.txt")
  await expect(attention).toContainText("Ada")
  await expect(island.getByTestId("island-prev")).toHaveAttribute("aria-label", "Previous request")
  await expect(island.getByTestId("island-next")).toHaveAttribute("aria-label", "Next request")
  await expect.poll(() => notices().length).toBeGreaterThanOrEqual(3)
  await expectFitted(app, island)
  // The approval answers of the approval card stay, and Open app joins them. The buttons may use
  // a second row. Every button is inside the window, and the page needs no scroll bar.
  await expect(island.getByTestId("island-allow")).toHaveText("Allow once")
  await expect(island.getByTestId("island-always")).toHaveText("Always allow for this agent")
  await expect(island.getByTestId("island-deny")).toHaveText("Deny")
  await expect(island.getByTestId("island-open")).toHaveText("Open app")
  const windowNow = await islandWindow(app)
  for (const id of ["allow", "always", "deny", "open"]) {
    const box = await island.getByTestId(`island-${id}`).boundingBox()
    expect(box, `button ${id}`).not.toBeNull()
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(windowNow?.height ?? 0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(windowNow?.width ?? 0)
  }
  await snap(island, "s33-03-attention.png")

  // Next and previous go through the requests.
  await island.getByTestId("island-next").click()
  await expect(position).toHaveText("2 of 3")
  await expect(summary).toContainText("b-second.txt")
  await expect(attention).toContainText("Bo")
  await island.getByTestId("island-next").click()
  await expect(position).toHaveText("3 of 3")
  await expect(summary).toContainText("c-third.txt")
  await expect(island.getByTestId("island-meta")).toHaveText("#Launch · Command")
  await island.getByTestId("island-prev").click()
  await island.getByTestId("island-prev").click()
  await expect(position).toHaveText("1 of 3")

  // Always allow the first one: the island shows "1 of 2" with the next request, and the task goes
  // on. The answer is "always" for this agent only, so the other requests still wait.
  expect(existsSync(paths.Ada)).toBe(true)
  await island.getByTestId("island-always").click()
  await expect(position).toHaveText("1 of 2")
  await expect(summary).toContainText("b-second.txt")
  await expect(attention).toContainText("Bo")
  await expect.poll(() => existsSync(paths.Ada), { timeout: 15_000 }).toBe(false)
  expect(existsSync(paths.Bo)).toBe(true)
  expect(existsSync(paths.Cy)).toBe(true)
  // The same command from the same agent asks no more. The rule is not wider than the step.
  writeFileSync(paths.Ada, "x")
  await sendTo(page, id("Ada"), rm(paths.Ada))
  await expect.poll(() => existsSync(paths.Ada), { timeout: 15_000 }).toBe(false)
  await expect(position).toHaveText("1 of 2")
  await expect(summary).toContainText("b-second.txt")

  // Deny the next one: one request is left, with no count.
  await island.getByTestId("island-deny").click()
  await expect(summary).toContainText("c-third.txt")
  await expect(position).toHaveCount(0)
  expect(existsSync(paths.Bo)).toBe(true)

  // A question has "Question" above it, up to 160 characters, and no Allow or Deny.
  await sendTo(page, id("Dee"), `TOOL ask_user ${JSON.stringify({ question: "Q".repeat(300) })}`)
  await expect(position).toHaveText("1 of 2")
  await island.getByTestId("island-next").click()
  await expect(position).toHaveText("2 of 2")
  await expect(island.getByTestId("island-meta")).toHaveText("Direct chat · Question")
  await expect(island.getByTestId("island-allow")).toHaveCount(0)
  await expect(island.getByTestId("island-deny")).toHaveCount(0)
  expect([...((await summary.textContent()) ?? "")]).toHaveLength(160)
  await expectFitted(app, island)
  await snap(island, "s33-04-question.png")
  await island.getByTestId("island-open").click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Dee")

  // Answers and stops empty the list; the island goes back to its idle or working shape.
  await island.getByTestId("island-prev").click()
  await island.getByTestId("island-allow").click()
  await expect.poll(() => existsSync(paths.Cy), { timeout: 15_000 }).toBe(false)
  await rpc(page, "chat.stop", { agentId: id("Dee") })
  await expect(attention).toHaveCount(0, { timeout: 15_000 })
  await expect(island.getByTestId("island-bar")).toBeVisible()
  await app.close()
})

test("island result card: reply and failure, 6 seconds, pointer, replace, mute, other modes", async () => {
  test.setTimeout(180_000)
  mkdirSync(shotsDir, { recursive: true })
  const { app, page, notices, victim } = await setup()
  await createAgent(page, "Ada")
  const { serverId } = await agentsOf(page)
  const island = await islandPage(app)
  const result = island.getByTestId("island-result")
  const line = island.getByTestId("island-result-line")
  const send = async (text: string) => {
    await page.getByTestId("composer-input").fill(text)
    await page.getByTestId("composer-input").press("Enter")
  }

  // A reply ends while the window is hidden: the card shows the first line.
  await send("hello")
  await expect(result).toBeVisible({ timeout: 15_000 })
  const shownAt = Date.now()
  await expect(island.getByTestId("island-result-name")).toHaveText("Ada")
  await expect(island.getByTestId("island-result-place")).toHaveText("Direct chat")
  await expect(line).toHaveText("Hello! You said: hello")
  await expect(result).toHaveAttribute("aria-label", "Reply")
  await expect(island.getByTestId("island-result-open")).toHaveText("Open app")
  expect(notices().length).toBe(1)
  await expectFitted(app, island)
  await snap(island, "s33-05-result.png")
  // It stays for 6 seconds.
  await island.waitForTimeout(4500)
  await expect(result).toBeVisible()
  await expect(result).toHaveCount(0, { timeout: 5000 })
  const stayed = Date.now() - shownAt
  expect(stayed).toBeGreaterThanOrEqual(5500)
  expect(stayed).toBeLessThanOrEqual(8500)
  await expect(island.getByTestId("island-bar")).toBeVisible()

  // The pointer keeps the card past 6 seconds. It goes when the pointer leaves.
  await send("hello two")
  await expect(result).toBeVisible({ timeout: 15_000 })
  const secondAt = Date.now()
  await result.hover()
  await island.waitForTimeout(Math.max(0, 7500 - (Date.now() - secondAt)))
  await expect(result).toBeVisible()
  await island.mouse.move(3000, 3000)
  await expect(result).toHaveCount(0, { timeout: 3000 })

  // A newer result replaces the older one at once. The first line is the only line.
  await send("hello three")
  await expect(line).toHaveText("Hello! You said: hello three", { timeout: 15_000 })
  await send("markdown please")
  await expect(line).toHaveText("## Plan", { timeout: 15_000 })
  await expect(result).toHaveCount(1)

  // "Open app" opens the message.
  await page.getByTestId("page-tasks").click()
  await island.getByTestId("island-result-open").click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Ada")
  await expect(page.locator("[data-testid=message][data-flash=true]")).toHaveCount(1, {
    timeout: 5000,
  })

  // A failure shows its reason. The mock fails a text only once, so this text is its own.
  await send("fail once for the island")
  await expect(result).toHaveAttribute("data-kind", "task_failed", { timeout: 15_000 })
  await expect(line).not.toHaveText("")
  await snap(island, "s33-06-failed.png")

  // A request for attention replaces the card at once.
  await send(`TOOL run_command ${JSON.stringify({ command: `rm "${victim("replace")}"` })}`)
  await expect(island.getByTestId("island-attention")).toBeVisible({ timeout: 15_000 })
  await expect(result).toHaveCount(0)
  await island.getByTestId("island-deny").click()
  await expect(island.getByTestId("island-attention")).toHaveCount(0, { timeout: 10_000 })
  // The turn ends with a reply, which makes a card of its own. Wait until that card has gone.
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
  await expect(result).toHaveCount(0, { timeout: 12_000 })

  // A muted server: no card and no notification.
  const before = notices().length
  await rpc(page, "notifications.setMute", { kind: "server", id: serverId, choice: "1h" })
  await send("muted")
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
  await island.waitForTimeout(800)
  await expect(result).toHaveCount(0)
  expect(notices().length).toBe(before)
  await rpc(page, "notifications.setMute", { kind: "server", id: serverId, choice: "off" })

  // The mode "only for attention": a notification shows, and the island shows no card.
  await rpc(page, "settings.update", { island: "attention" })
  await send("attention mode")
  await expect.poll(() => notices().length, { timeout: 15_000 }).toBe(before + 1)
  await island.waitForTimeout(800)
  await expect(result).toHaveCount(0)
  await expect.poll(async () => (await islandWindow(app))?.visible).toBe(false)

  // The mode "off" is the same for the card.
  await rpc(page, "settings.update", { island: "off" })
  await send("off mode")
  await expect.poll(() => notices().length, { timeout: 15_000 }).toBe(before + 2)
  await island.waitForTimeout(800)
  await expect(result).toHaveCount(0)
  await app.close()
})

test("island in Korean with reduce motion: texts, cards still show and close", async () => {
  test.setTimeout(150_000)
  const { app, page, victim } = await setup({ ROBOT_SYSTEM_LOCALE: "ko-KR" })
  for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)
  const { id } = await agentsOf(page)
  const island = await islandPage(app)
  await rpc(page, "settings.update", { reduceMotion: "on" })
  await expect(island.getByTestId("island")).toHaveAttribute("data-motion", "off")

  // The detail card, in Korean, with no movement.
  await sendTo(page, id("Ada"), "run long")
  await expect(island.getByTestId("island-count")).toHaveText("1", { timeout: 20_000 })
  await expect(island.getByTestId("island-bar")).toHaveAttribute(
    "aria-label",
    "작업 중인 에이전트: 1",
  )
  await island.getByTestId("island-bar").hover()
  await expect(island.getByTestId("island-detail")).toBeVisible()
  const row = island.getByTestId("island-row")
  await expect(row.getByTestId("island-row-place")).toHaveText("일대일 채팅")
  await expect(row.getByTestId("island-row-doing")).toHaveText("작업 중…")
  await expect(row).toHaveAttribute("aria-label", /이 장소 열기\.$/)
  const names = await island.evaluate(() =>
    [...document.querySelectorAll(".island, .card")].map((e) => getComputedStyle(e).animationName),
  )
  expect(names.every((n) => n === "none")).toBe(true)
  await island.mouse.move(3000, 3000)
  await expect(island.getByTestId("island-detail")).toHaveCount(0, { timeout: 3000 })

  // The attention card, in Korean.
  const rm = (path: string) => `TOOL run_command ${JSON.stringify({ command: `rm "${path}"` })}`
  await sendTo(page, id("Bo"), rm(victim("ko-one")))
  await expect(island.getByTestId("island-attention")).toBeVisible({ timeout: 20_000 })
  await expect(island.getByTestId("island-meta")).toHaveText("일대일 채팅 · 명령")
  await expect(island.getByTestId("island-allow")).toHaveText("한 번 허용")
  await expect(island.getByTestId("island-always")).toHaveText("이 에이전트에 항상 허용")
  await expect(island.getByTestId("island-deny")).toHaveText("거부")
  await expect(island.getByTestId("island-open")).toHaveText("앱 열기")
  await sendTo(page, id("Cy"), rm(victim("ko-two")))
  await expect(island.getByTestId("island-position")).toHaveText("2개 중 1번째")
  await expect(island.getByTestId("island-position")).toHaveAttribute(
    "aria-label",
    "요청 2개 중 1번째",
  )
  await expect(island.getByTestId("island-prev")).toHaveAttribute("aria-label", "이전 요청")
  await expect(island.getByTestId("island-next")).toHaveAttribute("aria-label", "다음 요청")
  await snap(island, "s33-07-korean.png")
  await island.getByTestId("island-deny").click()
  await island.getByTestId("island-deny").click()
  await expect(island.getByTestId("island-attention")).toHaveCount(0, { timeout: 15_000 })
  await app.close()
})
