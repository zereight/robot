import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { freePortPair } from "./ports.ts"
import { closeSettings, rpc, synced, turnOnSync } from "./sync-helpers.ts"

// Spec 030, "Channel tree" (S109): the field "Parent channel" with its rules (no loop, at most 3
// levels), the line "In <parent channel>" in the header, and the repair of a broken tree (030,
// "Repair") on two computers. The org chart draws organizations, not channels (029, S119), so the
// tree of channels has no chart here; the moves on the chart are in s108. Sync and export of the
// field are checked by unit tests (sync/kinds.test.ts, services/Data.test.ts), and the repair by
// unit tests too (shared/channelTree.test.ts, sync/channelRepair.test.ts, services/Sync.test.ts).
// The last test here shows the repair on two computers: the muted line and no notice. The repair of a
// restore has no screen yet (the archive of a channel is slice S19), so a unit test checks it.

interface ChannelInfo {
  id: string
  name: string
  parentId: string | null
}

const localServerId = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
/** Each channel by name with the name of its parent: "Docs < Product", or "Ops" at the top. */
const tree = async (page: Page) => {
  const list = await rpc<ChannelInfo[]>(page, "channels.list", {
    serverId: await localServerId(page),
  })
  const names = new Map(list.map((c) => [c.id, c.name]))
  return list.map((c) => (c.parentId ? `${c.name} < ${names.get(c.parentId)}` : c.name)).sort()
}
const makeAgents = async (page: Page, names: readonly string[]) => {
  const serverId = await localServerId(page)
  const ids: Record<string, string> = {}
  for (const name of names) {
    const made = await rpc<{ id: string }>(page, "agents.create", {
      serverId,
      name,
      role: "",
      instructions: "",
    })
    ids[name] = made.id
  }
  return ids
}
const makeChannel = async (
  page: Page,
  name: string,
  memberIds: string[],
  extra: { leadId?: string; parentId?: string } = {},
) =>
  rpc<ChannelInfo>(page, "channels.create", {
    serverId: await localServerId(page),
    name,
    topic: "",
    memberIds,
    leadId: extra.leadId ?? null,
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
  })

test("the channel tree: the field, its reasons, the header line and the level limit", async () => {
  test.setTimeout(240_000)
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1360, 900)
    const ids = await makeAgents(page, ["Ada", "Bo", "Cy", "Dee"])
    const product = await makeChannel(page, "Product", [ids.Ada as string])
    const docs = await makeChannel(page, "Docs", [ids.Bo as string, ids.Cy as string], {
      leadId: ids.Bo as string,
    })
    const site = await makeChannel(page, "Site", [ids.Cy as string])
    const ops = await makeChannel(page, "Ops", [ids.Dee as string])
    expect(await tree(page)).toEqual(["Docs", "Ops", "Product", "Site"])

    // The field "Parent channel" in the settings of "Docs": "Product". The header of "Docs" shows
    // "In Product", and a click opens "Product".
    await page.getByTestId(`place-channel-${docs.id}`).click()
    await expect(page.getByTestId("channel-header-name")).toHaveText("Docs")
    await expect(page.getByTestId("channel-header-parent")).toHaveCount(0)
    await page.getByTestId("channel-settings").click()
    await page.getByTestId("channel-parent").selectOption(product.id)
    await page.getByTestId("channel-submit").click()
    await expect(page.getByTestId("channel-dialog")).toHaveCount(0)
    await expect(page.getByTestId("channel-header-parent")).toHaveText("In Product")
    await shot(page, "s109-01-header-in-parent")
    await page.getByTestId("channel-header-parent").click()
    await expect(page.getByTestId("channel-header-name")).toHaveText("Product")
    await expect(page.getByTestId("channel-header-parent")).toHaveCount(0)

    // "Site" goes under "Docs". The field of "Product" shows "Docs" and "Site" muted with the
    // reason of a loop, and "Ops" with the reason of the levels: "Product" takes 3 levels.
    await rpc(page, "channels.update", { id: site.id, patch: { parentId: docs.id } })
    await page.getByTestId("channel-settings").click()
    const field = page.getByTestId("channel-parent")
    for (const [id, reason] of [
      [docs.id, "This is a sub-channel of this channel."],
      [site.id, "This is a sub-channel of this channel."],
      [ops.id, "The tree would have more than 3 levels."],
    ] as const) {
      const option = field.locator(`option[value="${id}"]`)
      await expect(option).toHaveAttribute("disabled", "")
      await expect(option).toContainText(reason)
    }
    await shot(page, "s109-02-parent-field")
    await page.getByTestId("channel-dialog").getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByTestId("channel-dialog")).toHaveCount(0)
    // A fourth level is refused by the server too.
    await expect(makeChannel(page, "Deep", [], { parentId: site.id })).rejects.toThrow(
      "parent_levels",
    )
    expect(await tree(page)).toEqual(["Docs < Product", "Ops", "Product", "Site < Docs"])
  } finally {
    await app.close().catch(() => {})
  }
})

test("sync: two computers put a channel under each other while apart; the later change loses its parent, and the channel shows one muted line and no notice", async () => {
  test.setTimeout(300_000)
  const logs = freshUserData()
  const notified = [join(logs, "one.jsonl"), join(logs, "two.jsonl")] as const
  const count = (file: string) =>
    existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0
  const env = (file: string) => ({ ROBOT_TEST_NOTIFY_LOG: file, ROBOT_TEST_UNFOCUSED: "1" })
  const s = await synced(await freePortPair(), [env(notified[0]), env(notified[1])])
  const { one, two } = s
  try {
    const docs = await makeChannel(one.page, "Docs", [])
    const site = await makeChannel(one.page, "Site", [])
    await turnOnSync(one, two)
    await closeSettings(one.page)
    await closeSettings(two.page)
    await expect.poll(() => tree(two.page)).toEqual(["Docs", "Site"])

    // Apart: each computer makes a change that is right alone. "Docs" goes under "Site" on MacBook
    // 1, and a little later "Site" goes under "Docs" on MacBook 2.
    const linkId = (await rpc<{ linkId: string }[]>(one.page, "sync.list"))[0]?.linkId
    await rpc(one.page, "sync.pause", { linkId })
    await expect
      .poll(async () => (await rpc<{ state: string }[]>(two.page, "sync.list"))[0]?.state, {
        timeout: 20_000,
      })
      .toBe("paused")
    await rpc(one.page, "channels.update", { id: docs.id, patch: { parentId: site.id } })
    await two.page.waitForTimeout(60)
    await rpc(two.page, "channels.update", { id: site.id, patch: { parentId: docs.id } })
    const before = [count(notified[0]), count(notified[1])]
    await rpc(one.page, "sync.resume", { linkId })

    // The change of "Site" is the later one: its parent field is cleared on both computers, and the
    // tree has no loop.
    await expect.poll(() => tree(one.page), { timeout: 30_000 }).toEqual(["Docs < Site", "Site"])
    await expect.poll(() => tree(two.page), { timeout: 30_000 }).toEqual(["Docs < Site", "Site"])
    // The line is no message of an agent: it adds no unread count, and it does not replace the
    // preview of the place (030, "Repair"). Nobody opened the channel yet, so a count would show.
    for (const page of [one.page, two.page]) {
      await expect
        .poll(
          async () =>
            (await rpc<unknown[]>(page, "channels.history", { channelId: site.id })).length,
          { timeout: 30_000 },
        )
        .toBe(1)
      const sections = await rpc<
        { places: { id: string; unread: number; lastMessage: string | null }[] }[]
      >(page, "places.list", { serverId: await localServerId(page) })
      expect(sections.flatMap((x) => x.places).find((p) => p.id === site.id)).toMatchObject({
        unread: 0,
        lastMessage: null,
      })
      const row = page.getByTestId(`place-channel-${site.id}`)
      await expect(row).toHaveAttribute("data-unread", "false")
      await expect(row.locator("span", { hasText: /^\d+$/ })).toHaveCount(0)
    }
    for (const page of [one.page, two.page]) {
      await page.getByTestId(`place-channel-${site.id}`).click()
      await expect(page.getByTestId("channel-header-name")).toHaveText("Site")
      const noteLine = page.getByTestId("note-line")
      await expect(noteLine).toHaveCount(1)
      await expect(noteLine).toContainText(
        "The parent channel was cleared. The tree would have a loop.",
      )
      await page.getByTestId(`place-channel-${docs.id}`).click()
      await expect(page.getByTestId("channel-header-name")).toHaveText("Docs")
      await expect(page.getByTestId("note-line")).toHaveCount(0)
    }
    await two.page.getByTestId(`place-channel-${site.id}`).click()
    await shot(two.page, "s109-07-repaired-loop")
    // The repair makes no notice on either computer.
    await two.page.waitForTimeout(1000)
    expect([count(notified[0]), count(notified[1])]).toEqual(before)
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})
