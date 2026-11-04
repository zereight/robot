import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Locator, type Page, test } from "@playwright/test"
import { freshUserData, type Launched, launch, resizeWindow, shot } from "./harness.ts"
import { freePortPair } from "./ports.ts"
import {
  closeSettings,
  envFor,
  openDevices,
  rpc,
  setName,
  synced,
  turnOnSync,
} from "./sync-helpers.ts"

// Spec 030, "Channel tree" (S109), with 029 and 012: the field "Parent channel" with its rules
// (no loop, at most 3 levels), the line "In <parent channel>" in the header, the tree on the org
// chart (layout, structure lines, focus order), "Put under…" and "Move to the top" with Undo, the
// drag of a channel node onto a channel node or onto the root, and a linked computer with the
// switch "Can create and change agents". Sync and export of the field are checked by unit tests
// (sync/kinds.test.ts, services/Data.test.ts), and the repair of a broken tree (030, "Repair") by
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

const channelNode = (page: Page, channelId: string) =>
  page.locator(`[data-testid=org-channel][data-key="c:${channelId}"]`)
const line = (page: Page, id: string) => page.locator(`[data-testid=org-line][data-id="${id}"]`)
const center = async (target: Locator) => {
  const box = await target.boundingBox()
  if (!box) throw new Error("no box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
/** Presses on `from`, moves onto `to` in steps, and runs `during` before the drop. */
const drag = async (page: Page, from: Locator, to: Locator, during?: () => Promise<void>) => {
  const start = await center(from)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 10, start.y + 10, { steps: 3 })
  const end = await center(to)
  await page.mouse.move(end.x, end.y, { steps: 8 })
  await during?.()
  await page.mouse.up()
}
const openMenu = async (page: Page, node: Locator) => {
  await node.click({ button: "right" })
  await expect(page.getByTestId("org-menu")).toBeVisible()
}

test("the channel tree: the field, the header line, the chart, Put under, Move to the top and a drag", async () => {
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
    await page.getByTestId("page-orgchart").click()
    await channelNode(page, docs.id).click()
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

    // The chart: each sub-channel node sits under the node of its parent, with a structure line
    // between them, and the root has no line to a sub-channel.
    await page.getByTestId("page-orgchart").click()
    await expect(channelNode(page, docs.id)).toHaveAttribute("data-parent", `c:${product.id}`)
    await expect(channelNode(page, site.id)).toHaveAttribute("data-level", "3")
    await expect(line(page, `s:c:${product.id}>c:${docs.id}`)).toHaveCount(1)
    await expect(line(page, `s:c:${docs.id}>c:${site.id}`)).toHaveCount(1)
    await expect(line(page, `s:root>c:${docs.id}`)).toHaveCount(0)
    await expect(line(page, `s:root>c:${product.id}`)).toHaveCount(1)
    const yOf = async (id: string) => (await center(channelNode(page, id))).y
    expect(await yOf(docs.id)).toBeGreaterThan(await yOf(product.id))
    expect(await yOf(site.id)).toBeGreaterThan(await yOf(docs.id))
    await shot(page, "s109-03-chart-tree")

    // Tab: the root, then each channel node, its agents, then its sub-channels.
    await page.getByTestId("org-canvas").click({ position: { x: 4, y: 4 } })
    const order: string[] = []
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab")
      order.push(
        await page.evaluate(
          () => document.activeElement?.getAttribute("aria-label")?.split(". ")[0] ?? "?",
        ),
      )
    }
    expect(order).toEqual(["You", "Ops", "Dee", "Product", "Ada", "Docs", "Bo", "Cy", "Site", "Cy"])
    await page.keyboard.press("Escape")

    // "Move to the top" on "Site", and Undo puts it back under "Docs".
    await openMenu(page, channelNode(page, site.id))
    await page.getByTestId("org-menu").getByTestId("org-menu-to-top").click()
    await expect(page.getByTestId("org-notice-text")).toHaveText("Moved Site to the top.")
    await expect.poll(() => tree(page)).toContain("Site")
    await expect(line(page, `s:root>c:${site.id}`)).toHaveCount(1)
    await page.getByTestId("org-undo").click()
    await expect(page.getByTestId("org-notice-text")).toHaveText("Undone.")
    await expect.poll(() => tree(page)).toContain("Site < Docs")
    // "Docs" is under "Product". Its menu has "Move to the top", and "Put under…" lists the
    // channels that the tree allows, but not "Product", its parent now (spec 030, "Channel tree"):
    // that pick would change nothing. "Site" is its own sub-channel, so only "Ops" is left.
    await page.keyboard.press("Escape")
    await openMenu(page, channelNode(page, docs.id))
    await expect(page.getByTestId("org-menu").getByTestId("org-menu-to-top")).toHaveCount(1)
    await page.getByTestId("org-menu").getByTestId("org-menu-put-under").click()
    const docsMenu = page.getByTestId("org-menu")
    await expect(docsMenu.getByTestId(`org-menu-under-${ops.id}`)).toBeVisible()
    await expect(docsMenu.getByTestId(`org-menu-under-${product.id}`)).toHaveCount(0)
    await expect(docsMenu.getByTestId(`org-menu-under-${site.id}`)).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("org-menu")).toHaveCount(0)
    // A top channel has no "Move to the top".
    await page.keyboard.press("Escape")
    await openMenu(page, channelNode(page, ops.id))
    await expect(page.getByTestId("org-menu").getByTestId("org-menu-to-top")).toHaveCount(0)

    // "Put under…" on "Ops" lists the channels that the tree allows: not "Site" (a fourth level).
    await page.getByTestId("org-menu").getByTestId("org-menu-put-under").click()
    const menu = page.getByTestId("org-menu")
    await expect(menu.getByTestId(`org-menu-under-${product.id}`)).toBeVisible()
    await expect(menu.getByTestId(`org-menu-under-${docs.id}`)).toBeVisible()
    await expect(menu.getByTestId(`org-menu-under-${site.id}`)).toHaveCount(0)
    await shot(page, "s109-04-put-under")
    await menu.getByTestId(`org-menu-under-${docs.id}`).click()
    await expect(page.getByTestId("org-notice-text")).toHaveText("Put Ops under Docs.")
    await expect.poll(() => tree(page)).toContain("Ops < Docs")
    await expect(channelNode(page, ops.id)).toHaveAttribute("data-parent", `c:${docs.id}`)

    // Drag "Product" onto "Docs", its own sub-channel: no ring, and the drop changes nothing.
    await drag(page, channelNode(page, product.id), channelNode(page, docs.id), async () => {
      await expect(channelNode(page, docs.id)).toHaveAttribute("data-ring", "false")
    })
    await expect(page.getByTestId("org-notice")).toContainText("Put Ops under Docs.")
    expect(await tree(page)).toEqual(["Docs < Product", "Ops < Docs", "Product", "Site < Docs"])
    // Drag "Ops" onto the root: it moves to the top.
    await drag(page, channelNode(page, ops.id), page.getByTestId("org-root"), async () => {
      await expect(page.getByTestId("org-root")).toHaveAttribute("data-ring", "true")
      await expect(page.getByTestId("org-drop-area")).toHaveCount(0)
    })
    await expect(page.getByTestId("org-notice-text")).toHaveText("Moved Ops to the top.")
    await expect.poll(() => tree(page)).toContain("Ops")
    // Drag "Ops" onto "Product": it goes under it.
    await drag(page, channelNode(page, ops.id), channelNode(page, product.id), async () => {
      await expect(channelNode(page, product.id)).toHaveAttribute("data-ring", "true")
    })
    await expect(page.getByTestId("org-notice-text")).toHaveText("Put Ops under Product.")
    await expect.poll(() => tree(page)).toContain("Ops < Product")
    await shot(page, "s109-05-dragged")
  } finally {
    await app.close().catch(() => {})
  }
})

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)

test("a linked computer with the switch Can create and change agents puts a channel under another", async () => {
  test.setTimeout(240_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const two: Launched = await launch(freshUserData(), envFor(PORT_2))
  const one: Launched = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(one.app, 1300, 860)
    const ids = await makeAgents(two.page, ["Ada", "Bo"])
    const product = await makeChannel(two.page, "Product", [ids.Ada as string])
    const docs = await makeChannel(two.page, "Docs", [ids.Bo as string])
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)

    // MacBook 1 connects one way. MacBook 2 leaves the switch "Can create and change agents" on.
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
    await one.page.getByTestId("connect-two-way").click()
    await one.page.getByTestId("connect-finish").click()
    await two.page.getByTestId("join-allow").click()
    await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
    await two.page.getByTestId("pair-close").click()
    await closeSettings(two.page)
    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")

    // The chart of MacBook 2 on MacBook 1: "Put under…" on "Docs" puts it under "Product" on
    // MacBook 2, and the chart draws it under its parent.
    await one.page.getByTestId("page-orgchart").click()
    await tile(one.page, "MacBook 2").click()
    await expect(channelNode(one.page, docs.id)).toBeVisible()
    await openMenu(one.page, channelNode(one.page, docs.id))
    await one.page.getByTestId("org-menu").getByTestId("org-menu-put-under").click()
    await one.page.getByTestId("org-menu").getByTestId(`org-menu-under-${product.id}`).click()
    await expect(one.page.getByTestId("org-notice-text")).toHaveText("Put Docs under Product.")
    await expect.poll(() => tree(two.page)).toEqual(["Docs < Product", "Product"])
    await expect(channelNode(one.page, docs.id)).toHaveAttribute("data-parent", `c:${product.id}`)
    await shot(one.page, "s109-06-linked-put-under")
    // Undo goes to MacBook 2 too.
    await one.page.getByTestId("org-undo").click()
    await expect.poll(() => tree(two.page)).toEqual(["Docs", "Product"])
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
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
