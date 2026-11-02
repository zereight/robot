import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import {
  closeSettings,
  envFor,
  rowOf,
  rpc,
  send,
  settled,
  synced,
  turnOnSync,
} from "./sync-helpers.ts"

// The Today page (spec 021): what waits for the user, what went wrong, what ran today, and what
// runs next. One computer shows the groups; two computers show the rows of the other one and the
// line of a linked server.

const HOUR = 3_600_000

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}
interface WaitingInfo {
  agent: { id: string }
  callId: string
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await serverOf(page), archived: false })
const agentId = async (page: Page, name: string) =>
  (await agentsOf(page)).find((a) => a.name === name)?.id as string

const waiting = (path: string) => `TOOL run_command ${JSON.stringify({ command: `rm "${path}"` })}`

const rows = (page: Page, group: string) =>
  page.getByTestId(`today-group-${group}`).getByTestId("today-row")
const openToday = async (page: Page) => {
  await page.getByTestId("page-today").click()
  await expect(page.getByTestId("today-page")).toBeVisible()
}

const nameDevice = async (page: Page, name: string) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-devices").click()
  await page.getByTestId("device-name").fill(name)
  await page.getByTestId("device-name").press("Enter")
  await expect(page.getByTestId("device-name")).toHaveValue(name)
}

const routineOf = (page: Page, agent: string, name: string, prompt: string, at?: number) =>
  serverOf(page).then((serverId) =>
    rpc<{ id: string }>(page, "routines.create", {
      serverId,
      agentId: agent,
      name,
      prompt,
      schedule: { kind: "once", at: at ?? Date.now() + 3 * HOUR },
      place: { kind: "agent" },
    }),
  )

/** The tasks of a routine, by their state. */
const routineTasks = async (page: Page, state: string) =>
  (
    await rpc<{ state: string; source: string }[]>(page, "tasks.list", {
      serverId: await serverOf(page),
    })
  ).filter((t) => t.source === "routine" && t.state === state).length

const runRoutine = async (page: Page, id: string, state: string, count: number) => {
  await rpc(page, "routines.runNow", { id })
  await expect.poll(() => routineTasks(page, state), { timeout: 20_000 }).toBe(count)
}

test("today: empty page, approval row and badge, order, Show more, live update", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const outside = join(userData, "outside")
  mkdirSync(outside, { recursive: true })
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A new app with no work: the page shows only "Needs you", with its muted line. No badge.
  await openToday(page)
  await expect(page.locator("[data-testid^=today-group-]")).toHaveCount(1)
  await expect(page.getByTestId("today-group-needs")).toBeVisible()
  await expect(page.getByTestId("today-empty")).toHaveText("Nothing waits for you.")
  await expect(page.getByTestId("page-today-badge")).toHaveCount(0)
  await shot(page, "s48-01-empty")

  // An approval waits. The page is open, and the row shows within 1 second of the request.
  const long = join(outside, `${"a-long-file-name-".repeat(8)}.txt`)
  writeFileSync(long, "x")
  const ada = await agentId(page, "Ada")
  await rpc(page, "chat.send", { agentId: ada, text: waiting(long), replyTo: null })
  await expect
    .poll(async () => (await rpc<{ waiting: unknown[] }>(page, "island.get")).waiting.length, {
      intervals: [25],
      timeout: 15_000,
    })
    .toBe(1)
  await expect(rows(page, "needs")).toHaveCount(1, { timeout: 1000 })
  await expect(page.getByTestId("page-today-badge")).toHaveText("1", { timeout: 1000 })
  await expect(rows(page, "needs").first()).toHaveAttribute("data-kind", "approval")
  // A row line has at most 90 characters, and a longer line ends with "…".
  const line = (
    (await rows(page, "needs").first().getByTestId("today-line").textContent()) ?? ""
  ).trim()
  expect([...line].length).toBeLessThanOrEqual(90)
  expect(line.endsWith("…")).toBe(true)
  await shot(page, "s48-02-approval")

  // A click opens the chat at the card.
  await rows(page, "needs").first().click()
  await expect(page.getByTestId("ask-card")).toBeVisible()
  await openToday(page)

  // Allow the step: the row and the badge leave within 1 second.
  const [card] = (await rpc<{ waiting: WaitingInfo[] }>(page, "island.get")).waiting
  await rpc(page, "island.respond", {
    agentId: card?.agent.id,
    callId: card?.callId,
    answer: "allow",
  })
  await expect(rows(page, "needs")).toHaveCount(0, { timeout: 1000 })
  await expect(page.getByTestId("page-today-badge")).toHaveCount(0, { timeout: 1000 })
  await expect(page.getByTestId("today-empty")).toBeVisible()

  // 21 approvals wait: 20 rows and "Show more", and the badge counts 21.
  const template = (await agentsOf(page))[0] as AgentInfo
  const server = await serverOf(page)
  const ids = [ada]
  for (let i = 2; i <= 21; i++) {
    const made = await rpc<{ id: string }>(page, "agents.create", {
      serverId: server,
      name: `Agent ${i}`,
      role: "",
      instructions: "",
      model: template.model,
    })
    ids.push(made.id)
  }
  for (const id of ids) {
    writeFileSync(join(outside, `${id}.txt`), "x")
    await rpc(page, "chat.send", {
      agentId: id,
      text: waiting(join(outside, `${id}.txt`)),
      replyTo: null,
    })
  }
  await expect(page.getByTestId("page-today-badge")).toHaveText("21", { timeout: 30_000 })
  await expect(rows(page, "needs")).toHaveCount(20)
  await expect(page.getByTestId("today-more")).toBeVisible()
  await shot(page, "s48-03-show-more")
  await page.getByTestId("today-more").click()
  await expect(rows(page, "needs")).toHaveCount(21)
  await expect(page.getByTestId("today-more")).toHaveCount(0)
  // The oldest row is first, and the badge counts all of them.
  const snapshot = await rpc<{ badge: number; groups: { id: string; rows: { at: number }[] }[] }>(
    page,
    "today.get",
  )
  const asked = snapshot.groups.find((g) => g.id === "needs")?.rows.map((r) => r.at) ?? []
  expect(asked).toHaveLength(21)
  expect(asked).toEqual([...asked].sort((x, y) => x - y))
  expect(snapshot.badge).toBe(21)

  await app.close()
  await mock.close()
})

test("today: went wrong, plan limit, retry, paused routine, done today, next 24 hours", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const ada = await agentId(page, "Ada")

  // A task of a chat fails today: a row shows in "Went wrong". Retry the task: the old row leaves.
  await send(page, "please fail once for today")
  await settled(page)
  await openToday(page)
  await expect(rows(page, "wrong")).toHaveCount(1)
  await expect(rows(page, "wrong").first()).toHaveAttribute("data-kind", "task_failed")
  await expect(page.getByTestId("today-group-done")).toHaveCount(0)
  await expect(page.getByTestId("today-group-next")).toHaveCount(0)
  await shot(page, "s48-04-went-wrong")
  await rows(page, "wrong").first().click()
  await expect(page.getByTestId("tasks-page")).toBeVisible()
  await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "failed")
  await page.getByTestId("task-retry").click()
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toHaveCount(0)
  await openToday(page)
  await expect(page.getByTestId("today-group-wrong")).toHaveCount(0, { timeout: 15_000 })

  // The model account reports that its plan limit is reached: a row with the reset time shows. A
  // turn of that account then succeeds: the row leaves.
  await rpc(page, "chat.send", { agentId: ada, text: "hit the limit", replyTo: null })
  const limit = page.locator("[data-testid=today-row][data-kind=account_limit]")
  await expect(limit).toHaveCount(1, { timeout: 15_000 })
  await expect(limit.getByTestId("today-line")).toContainText("plan limit reached, resets at")
  await shot(page, "s48-05-plan-limit")
  await rpc(page, "chat.send", { agentId: ada, text: "hello again", replyTo: null })
  await expect(limit).toHaveCount(0, { timeout: 15_000 })

  // A routine runs twice today and ends as done both times: "Done today" has one row with the
  // count 2. The same routine is due in 3 hours: "Next 24 hours" shows it. Pause it: the row
  // leaves from "Next 24 hours".
  const good = await routineOf(page, ada, "Morning check", "Say good morning")
  await expect(rows(page, "next")).toHaveCount(1)
  await expect(rows(page, "next").first()).toHaveAttribute("data-kind", "routine_next")
  await runRoutine(page, good.id, "done", 1)
  await runRoutine(page, good.id, "done", 2)
  await expect(rows(page, "done")).toHaveCount(1)
  await expect(rows(page, "done").first().getByTestId("today-source")).toContainText("2 runs")
  await shot(page, "s48-06-done-and-next")
  await rpc(page, "routines.update", { id: good.id, patch: { enabled: false } })
  await expect(page.getByTestId("today-group-next")).toHaveCount(0, { timeout: 1000 })
  await rpc(page, "routines.delete", { id: good.id })

  // A routine fails 3 runs in a row and is paused: one row, with the word "Paused". Resume it:
  // the row leaves. The failed runs are not listed as tasks.
  await rpc(page, "chat.send", { agentId: ada, text: "hello once more", replyTo: null })
  const bad = await routineOf(page, ada, "Weekly report", "hit the limit")
  for (const n of [1, 2, 3]) await runRoutine(page, bad.id, "failed", n)
  // A failed run today gives the routine one row. The failed runs are not listed as tasks.
  const failed = page.locator("[data-testid=today-row][data-kind=routine_failed]")
  await expect(failed).toHaveCount(1, { timeout: 5000 })
  await expect(page.locator("[data-testid=today-row][data-kind=task_failed]")).toHaveCount(1)
  await rpc(page, "routines.update", { id: bad.id, patch: { enabled: false } })
  const routineRow = page.locator("[data-testid=today-row][data-kind=routine_paused]")
  await expect(routineRow).toHaveCount(1, { timeout: 5000 })
  await expect(routineRow.getByTestId("today-line")).toContainText("Paused")
  await expect(rows(page, "wrong").filter({ hasText: "Weekly report" })).toHaveCount(1)
  await shot(page, "s48-07-paused-routine")
  await routineRow.click()
  await expect(page.locator(`[data-routine-id="${bad.id}"]`)).toBeVisible()
  await openToday(page)
  await rpc(page, "routines.update", { id: bad.id, patch: { enabled: true } })
  await expect(routineRow).toHaveCount(0, { timeout: 5000 })

  await app.close()
  await mock.close()
})

test("today: a sync partner's approval shows with its computer, and its routine does not show in Next 24 hours", async () => {
  test.setTimeout(300_000)
  const s = await synced(await freePortPair())
  const { one, two } = s
  try {
    await createAgent(one.page, "Ada")
    await turnOnSync(one, two)
    await closeSettings(one.page)
    await closeSettings(two.page)
    await expect(rowOf(two.page, "Ada")).toBeVisible({ timeout: 20_000 })
    await rowOf(one.page, "Ada").click()
    await rowOf(two.page, "Ada").click()
    const keep = join(s.data1, "keep.txt")
    writeFileSync(keep, "x")

    // A routine of the first computer is due in 3 hours. It shows in "Next 24 hours" there, and
    // not on the second computer, where it does not run.
    await routineOf(one.page, await agentId(one.page, "Ada"), "Morning check", "hello")
    await openToday(one.page)
    await expect(rows(one.page, "next")).toHaveCount(1)
    await expect
      .poll(
        async () =>
          (
            await rpc<unknown[]>(two.page, "routines.list", {
              serverId: await serverOf(two.page),
            })
          ).length,
        { timeout: 20_000 },
      )
      .toBe(1)
    await openToday(two.page)
    await expect(two.page.getByTestId("today-group-next")).toHaveCount(0)

    // A task on the first computer waits for an approval. The second computer shows the row with
    // the name of the first one, and counts it in the badge.
    await one.page.getByTestId("page-chats").click()
    await send(one.page, waiting(keep))
    await expect(one.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    const row = rows(two.page, "needs")
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    await expect(row.first().getByTestId("today-source")).toContainText("MacBook 1")
    await expect(two.page.getByTestId("page-today-badge")).toHaveText("1")
    // The island of the second computer has no "Always allow" for it (015).
    const island = await rpc<{ waiting: { always: boolean }[] }>(two.page, "island.get")
    expect(island.waiting.map((w) => w.always)).toEqual([false])
    await shot(two.page, "s48-08-sync-peer-row")

    // A click opens the card on the second computer. The answer there ends the row on both.
    await row.first().click()
    await expect(two.page.getByTestId("ask-card")).toBeVisible()
    await expect(two.page.getByTestId("ask-always")).toHaveCount(0)
    await two.page.getByTestId("ask-allow").click()
    await openToday(two.page)
    await expect(rows(two.page, "needs")).toHaveCount(0, { timeout: 15_000 })
    await expect(two.page.getByTestId("page-today-badge")).toHaveCount(0)
    await expect(one.page.getByTestId("page-today-badge")).toHaveCount(0)
    await expect.poll(() => existsSync(keep), { timeout: 15_000 }).toBe(false)
  } finally {
    await one.app.close().catch(() => undefined)
    await two.app.close().catch(() => undefined)
    await s.mock.close()
  }
})

test("today: a linked server shows the line and no badge", async () => {
  test.setTimeout(240_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(PORT_2))
  const one = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(two.app, 1200, 860)
    await resizeWindow(one.app, 1200, 860)
    await connectMock(one.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(one.page, "Ada")
    await nameDevice(two.page, "MacBook 2")
    await two.page.getByTestId("settings-close").click()
    await nameDevice(one.page, "MacBook 1")
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
    await two.page.getByTestId("join-allow").click()
    await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
    await two.page.getByTestId("pair-close").click()
    await two.page.getByTestId("settings-close").click()
    const linked = one.page.locator('[data-testid=server-tile][data-name="MacBook 2"]')
    await expect(linked).toHaveAttribute("data-state", "online")

    // An approval waits on MacBook 1: its badge is 1.
    const keep = join(one.userData, "keep.txt")
    writeFileSync(keep, "x")
    await send(one.page, waiting(keep))
    await expect(one.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await expect(one.page.getByTestId("page-today-badge")).toHaveText("1")

    // The linked server is on the screen: the page shows the line, and the badge is hidden.
    await linked.click()
    await one.page.getByTestId("page-today").click()
    await expect(one.page.getByTestId("page-open-on-server")).toHaveText("Open this on MacBook 2.")
    await expect(one.page.getByTestId("today-page")).toHaveCount(0)
    await expect(one.page.getByTestId("page-today-badge")).toHaveCount(0)
    await shot(one.page, "s48-09-linked-server")

    // This computer again: the page and the badge come back.
    await one.page.locator("[data-testid=server-tile]").first().click()
    await one.page.getByTestId("page-today").click()
    await expect(one.page.getByTestId("today-page")).toBeVisible()
    await expect(one.page.getByTestId("page-today-badge")).toHaveText("1")
    await expect(rows(one.page, "needs")).toHaveCount(1)
  } finally {
    await one.app.close().catch(() => undefined)
    await two.app.close().catch(() => undefined)
    await mock.close()
  }
})

test("today: the Korean page has no English text except names", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const ada = await agentId(page, "Ada")
  await openToday(page)
  await expect(page.getByTestId("today-empty")).toContainText(/[가-힣]/)

  // A plan limit, a routine that is due, and a routine that ran: each row is in Korean.
  await rpc(page, "chat.send", { agentId: ada, text: "hit the limit", replyTo: null })
  await expect(page.locator("[data-testid=today-row][data-kind=account_limit]")).toHaveCount(1, {
    timeout: 15_000,
  })
  const good = await routineOf(page, ada, "Daily", "Say good morning")
  await runRoutine(page, good.id, "done", 1)
  await expect(page.getByTestId("today-group-done")).toBeVisible()
  await expect(page.getByTestId("today-group-next")).toBeVisible()
  await shot(page, "s48-10-korean")

  // The task row shows the prompt of the user, so it is left out. Names are removed too.
  const text = await page.getByTestId("today-page").evaluate((el) =>
    [...el.querySelectorAll("h2, [data-testid=today-source], [data-testid=today-time]")]
      .map((n) => n.textContent ?? "")
      .concat(
        [
          ...el.querySelectorAll("[data-kind=account_limit] [data-testid=today-line]"),
          ...el.querySelectorAll("[data-kind=routine_next] [data-testid=today-line]"),
        ].map((n) => n.textContent ?? ""),
      )
      .join("\n"),
  )
  const rest = text.replaceAll("Mock", "").replaceAll("Ada", "").replaceAll("Daily", "")
  expect(rest).toMatch(/[가-힣]/)
  expect(rest).not.toMatch(/[A-Za-z]{2,}/)
  await app.close()
  await mock.close()
})
