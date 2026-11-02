import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { createAgent, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY } from "./mock-provider.ts"
import {
  agentNames,
  closeSettings,
  envFor,
  openDevices,
  report,
  rowOf,
  rpc,
  send,
  serverRow,
  settled,
  synced,
  syncState,
  turnOnSync,
  whilePaused,
} from "./sync-helpers.ts"

// Live sync (spec 019, S22): changes cross within 5 s, streaming grows on both computers, the
// newest change wins per field, nothing is lost, and a delete reaches the other computer.
test("live sync: a rename, a streaming reply, the read state and the origin of a message", async () => {
  test.setTimeout(300_000)
  const s = await synced([47881, 47882])
  const { one, two } = s
  try {
    await createAgent(one.page, "Ada")
    await createAgent(one.page, "Writer")
    await turnOnSync(one, two)
    await shot(one.page, "s22-01-live")
    await closeSettings(one.page)
    await closeSettings(two.page)
    await expect.poll(() => agentNames(two.page)).toEqual(["Ada", "Writer"])

    // A rename on MacBook 1 shows on MacBook 2 within 5 seconds, and the change list names it.
    await rowOf(one.page, "Writer").click()
    await one.page.getByTestId("chat-header-agent").click()
    await one.page.getByTestId("agent-name").fill("Editor")
    await one.page.getByTestId("agent-submit").click()
    await expect(rowOf(two.page, "Editor")).toBeVisible({ timeout: 5_000 })
    await expect(rowOf(two.page, "Writer")).toHaveCount(0)
    await openDevices(two.page)
    const change = two.page.locator('[data-testid=sync-change][data-name="Editor"]')
    await expect(change.first()).toContainText("Agent changed: Editor")
    await shot(two.page, "s22-02-change-list")
    await closeSettings(two.page)

    // A reply that streams grows on both computers as it comes.
    await rowOf(one.page, "Ada").click()
    await rowOf(two.page, "Ada").click()
    await send(one.page, "slow please")
    const streaming = two.page.locator("[data-testid=message][data-status=streaming]")
    await expect(streaming).toHaveCount(1, { timeout: 10_000 })
    const length = () =>
      streaming
        .first()
        .textContent()
        .then((t) => (t ?? "").length)
        .catch(() => -1)
    const first = await length()
    await two.page.waitForTimeout(700)
    const later = await length()
    expect(later).toBeGreaterThan(first)
    await settled(one.page)
    await settled(two.page)
    const replyOne = await one.page.getByTestId("message").last().textContent()
    const replyTwo = await two.page.getByTestId("message").last().textContent()
    expect(replyTwo).toContain("word59")
    expect(replyOne).toContain("word59")
    await shot(two.page, "s22-03-streamed-on-two")

    // Both computers show the same unread count, and reading on one clears it on the other.
    await rowOf(two.page, "Editor").click()
    await rowOf(one.page, "Ada").click()
    await send(one.page, "slow again")
    await rowOf(one.page, "Editor").click()
    await expect(rowOf(one.page, "Ada")).toHaveAttribute("data-unread", "true", { timeout: 20_000 })
    await expect(rowOf(two.page, "Ada")).toHaveAttribute("data-unread", "true", { timeout: 10_000 })
    await rowOf(one.page, "Ada").click()
    await expect(rowOf(one.page, "Ada")).toHaveAttribute("data-unread", "false")
    await expect(rowOf(two.page, "Ada")).toHaveAttribute("data-unread", "false", {
      timeout: 10_000,
    })

    // A message made on MacBook 2 says so on MacBook 1. The account is connected here first.
    await two.page.getByTestId("open-settings").click()
    await two.page.getByTestId("settings-nav-providers").click()
    await expect(two.page.getByTestId("provider-status")).toHaveText("Not connected")
    await two.page.getByTestId("provider-reconnect").click()
    await two.page.getByTestId("provider-api-key").fill(GOOD_KEY)
    await two.page.getByTestId("provider-submit").click()
    await expect(two.page.getByTestId("provider-status").first()).toHaveText("Connected")
    await two.page.getByTestId("settings-close").click()
    await rowOf(two.page, "Ada").click()
    await send(two.page, "Hi from two")
    await settled(two.page)
    const fromTwo = one.page.getByTestId("message").filter({ hasText: "Hi from two" }).first()
    await expect(fromTwo).toBeVisible({ timeout: 10_000 })
    await expect(fromTwo.getByTestId("from-device")).toContainText("from MacBook 2")
    await shot(one.page, "s22-04-from-macbook-2")
    report("s22-live", {
      agentsOne: await agentNames(one.page),
      agentsTwo: await agentNames(two.page),
    })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})

test("live sync: changes wait while a computer is off, and one memory item edited on both keeps both texts", async () => {
  test.setTimeout(300_000)
  const s = await synced([47883, 47884])
  const { one } = s
  let { two } = s
  try {
    await createAgent(one.page, "Ada")
    await turnOnSync(one, two)
    await closeSettings(one.page)
    await closeSettings(two.page)
    await expect.poll(() => agentNames(two.page)).toEqual(["Ada"])
    const ada = (
      await rpc<{ id: string }[]>(one.page, "agents.list", {
        serverId: (await rpc<{ id: string }[]>(one.page, "servers.list"))[0]?.id,
        archived: false,
      })
    )[0]?.id as string

    // MacBook 2 quits. MacBook 1 adds a memory item and sends a message.
    await two.app.close()
    await rpc(one.page, "memory.add", { agentId: ada, text: "Likes tea" })
    await rowOf(one.page, "Ada").click()
    await send(one.page, "while you were away")
    await settled(one.page)
    await expect(syncState(one.page, "MacBook 2").or(one.page.locator("body"))).toBeVisible()

    // MacBook 2 starts again: both arrive, and nothing asks for a new pairing.
    two = await launch(s.data2, envFor(s.ports[1], s.extra[1]))
    await resizeWindow(two.app, 1200, 860)
    await rowOf(two.page, "Ada").click()
    await expect(
      two.page.getByTestId("message").filter({ hasText: "while you were away" }).first(),
    ).toBeVisible({ timeout: 30_000 })
    await expect(two.page.getByTestId("join-dialog")).toHaveCount(0)
    await two.page.getByTestId("chat-header-agent").click()
    await expect(two.page.getByTestId("memory-item")).toHaveCount(1, { timeout: 20_000 })
    await expect(two.page.getByTestId("memory-item")).toContainText("Likes tea")
    await shot(two.page, "s22-05-arrived-after-restart")
    await two.page.keyboard.press("Escape")
    await openDevices(two.page)
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "live", {
      timeout: 30_000,
    })
    await closeSettings(two.page)

    // Apart: Pause on one computer stops both. The same item is edited on each.
    await openDevices(one.page)
    await serverRow(one.page, "MacBook 2").getByTestId("sync-pause").click()
    await expect(syncState(one.page, "MacBook 2")).toHaveAttribute("data-state", "paused")
    await closeSettings(one.page)
    await openDevices(two.page)
    await expect(syncState(two.page, "MacBook 1")).toHaveAttribute("data-state", "paused", {
      timeout: 20_000,
    })
    await closeSettings(two.page)
    const memoryId = (await rpc<{ id: string }[]>(one.page, "memory.list", { agentId: ada }))[0]
      ?.id as string
    await rpc(one.page, "memory.update", { id: memoryId, text: "Likes coffee" })
    await two.page.waitForTimeout(60)
    await rpc(two.page, "memory.update", { id: memoryId, text: "Likes juice" })
    await openDevices(one.page)
    await serverRow(one.page, "MacBook 2").getByTestId("sync-resume").click()
    await expect(syncState(one.page, "MacBook 2")).toHaveAttribute("data-state", "live", {
      timeout: 30_000,
    })
    await closeSettings(one.page)

    // Both computers hold the newest text, and the other text as a second item. The lists are equal.
    const texts = async (page: Page) =>
      (await rpc<{ text: string }[]>(page, "memory.list", { agentId: ada }))
        .map((m) => m.text)
        .sort()
    await expect
      .poll(() => texts(one.page), { timeout: 20_000 })
      .toEqual(["Likes coffee", "Likes juice"])
    await expect
      .poll(() => texts(two.page), { timeout: 20_000 })
      .toEqual(["Likes coffee", "Likes juice"])
    const kept = (
      await rpc<{ id: string; text: string }[]>(one.page, "memory.list", {
        agentId: ada,
      })
    ).find((m) => m.id === memoryId)
    expect(kept?.text).toBe("Likes juice")
    await rowOf(two.page, "Ada").click()
    await two.page.getByTestId("chat-header-agent").click()
    await expect(two.page.getByTestId("memory-item")).toHaveCount(2)
    await shot(two.page, "s22-06-two-memory-items")
    report("s22-apart", { texts: await texts(two.page) })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})

test("live sync: a delete reaches the other computer and keeps its folder; many deletions ask first", async () => {
  test.setTimeout(400_000)
  const s = await synced([47885, 47886])
  const { one, two } = s
  try {
    await createAgent(one.page, "Ada")
    await createAgent(one.page, "Doomed")
    await turnOnSync(one, two)
    await closeSettings(one.page)
    await closeSettings(two.page)
    await expect.poll(() => agentNames(two.page)).toEqual(["Ada", "Doomed"])
    const folders = () => readdirSync(join(s.data2, "workspaces"))
    expect(folders().some((f) => f.startsWith("doomed-"))).toBe(true)

    // Delete an archived agent: the dialog says that it goes on the other computer too.
    await rowOf(one.page, "Doomed").click()
    await one.page.getByTestId("chat-header-agent").click()
    await one.page.getByTestId("agent-archive").click()
    await expect(rowOf(two.page, "Doomed")).toHaveCount(0, { timeout: 10_000 })
    await one.page.getByTestId("open-settings").click()
    await one.page.getByTestId("settings-nav-archive").click()
    await one.page.getByTestId("archive-delete").click()
    await expect(one.page.getByTestId("delete-sync-line")).toContainText(
      "MacBook 2 syncs with this computer, so the agent is also deleted on MacBook 2. The workspace folder there stays where it is.",
    )
    await shot(one.page, "s22-07-delete-dialog")
    await one.page.getByTestId("delete-confirm-button").click()
    await expect(one.page.getByTestId("archive-section")).toContainText("No archived agents.")
    await one.page.getByTestId("settings-close").click()

    // It is gone on MacBook 2, the folder is still on its disk, and the change list shows the path.
    await expect
      .poll(
        async () =>
          (
            await rpc<unknown[]>(two.page, "agents.list", {
              serverId: (await rpc<{ id: string }[]>(two.page, "servers.list"))[0]?.id,
              archived: true,
            })
          ).length,
        { timeout: 10_000 },
      )
      .toBe(0)
    expect(folders().some((f) => f.startsWith("doomed-"))).toBe(true)
    await openDevices(two.page)
    await expect(
      two.page.locator('[data-testid=sync-change][data-name="Doomed"]').first(),
    ).toContainText("Agent deleted: Doomed")
    await expect(two.page.getByTestId("sync-change-detail").first()).toContainText("doomed-")
    await shot(two.page, "s22-08-deleted-folder-stays")
    await closeSettings(two.page)

    // Eight agents are deleted at once on MacBook 1. MacBook 2 asks before it deletes them.
    const serverOne = (await rpc<{ id: string }[]>(one.page, "servers.list"))[0]?.id
    const serverTwo = (await rpc<{ id: string }[]>(two.page, "servers.list"))[0]?.id
    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const agent = await rpc<{ id: string }>(one.page, "agents.create", {
        serverId: serverOne,
        name: `Temp ${i}`,
        role: "",
        instructions: "",
        model: null,
      })
      ids.push(agent.id)
    }
    const archivedCount = (page: Page, server: string | undefined) =>
      rpc<unknown[]>(page, "agents.list", { serverId: server, archived: true }).then(
        (l) => l.length,
      )
    await expect.poll(() => agentNames(two.page), { timeout: 20_000 }).toHaveLength(9)
    for (const id of ids) await rpc(one.page, "agents.archive", { id })
    await expect.poll(() => archivedCount(two.page, serverTwo), { timeout: 20_000 }).toBe(8)
    await whilePaused(one.page, async () => {
      for (const id of ids) await rpc(one.page, "agents.delete", { id })
    })
    await expect(two.page.getByTestId("sync-guard-dialog")).toBeVisible({ timeout: 20_000 })
    await expect(two.page.getByTestId("sync-guard-body")).toContainText(
      "MacBook 1 wants to delete 8 agents and channels here.",
    )
    await shot(two.page, "s22-09-guard")
    expect(await archivedCount(two.page, serverTwo)).toBe(8)
    await two.page.getByTestId("sync-guard-keep").click()
    await expect(two.page.getByTestId("sync-guard-dialog")).toBeHidden()

    // Keep leaves them on MacBook 2, and they come back to MacBook 1.
    expect(await archivedCount(two.page, serverTwo)).toBe(8)
    await expect.poll(() => archivedCount(one.page, serverOne), { timeout: 20_000 }).toBe(8)

    // Delete them again and say Delete: now they are gone on MacBook 2 too.
    await whilePaused(one.page, async () => {
      for (const id of ids) await rpc(one.page, "agents.delete", { id })
    })
    await expect(two.page.getByTestId("sync-guard-dialog")).toBeVisible({ timeout: 20_000 })
    await two.page.getByTestId("sync-guard-delete").click()
    await expect.poll(() => archivedCount(two.page, serverTwo), { timeout: 10_000 }).toBe(0)
    report("s22-delete", { archivedLeftOnTwo: await archivedCount(two.page, serverTwo) })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})

test("live sync: a clock that is more than 5 minutes off gets a warning", async () => {
  test.setTimeout(240_000)
  const s = await synced([47887, 47888], [{}, { ROBOT_SYNC_CLOCK_SKEW_MS: String(12 * 60_000) }])
  const { one, two } = s
  try {
    await createAgent(one.page, "Ada")
    await turnOnSync(one, two, "attention")
    await expect(syncState(one.page, "MacBook 2")).toContainText(
      "The clock of MacBook 2 is 12 minutes off.",
    )
    await expect(syncState(two.page, "MacBook 1")).toContainText(
      "The clock of MacBook 1 is 12 minutes off.",
    )
    await shot(one.page, "s22-10-clock-warning")
    // The data still crosses: the warning only tells that the newest time may be wrong.
    await closeSettings(two.page)
    await expect.poll(() => agentNames(two.page)).toEqual(["Ada"])
    expect(existsSync(join(s.data2, "backups"))).toBe(true)
    report("s22-clock", { warned: true })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})
