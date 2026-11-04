import { expect, type Locator, type Page, test } from "@playwright/test"
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
import { closeSettings, envFor, openDevices, rpc, setName } from "./sync-helpers.ts"

// Spec 029, "Edit on the chart" (S108): the menus of the nodes, drag and drop with Option to add,
// the rings, the refusal of a member that works, the line with "Undo" and Cmd+Z, the keys for each
// edit, and a linked computer with the switch "Can create and change agents" (012).

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}
interface ChannelInfo {
  id: string
  name: string
  leadId: string | null
  memberIds: string[]
}

const localServerId = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await localServerId(page), archived: false })
const channelsOf = async (page: Page) =>
  rpc<ChannelInfo[]>(page, "channels.list", { serverId: await localServerId(page) })
/** The members of each channel by name, and its lead: "Docs: Ada*, Cy" (the lead has a star). */
const teams = async (page: Page) => {
  const names = new Map((await agentsOf(page)).map((a) => [a.id, a.name]))
  return (await channelsOf(page))
    .map(
      (c) =>
        `${c.name}: ${c.memberIds
          .map((m) => `${names.get(m)}${m === c.leadId ? "*" : ""}`)
          .sort()
          .join(", ")}`,
    )
    .sort()
}

/** The node of an agent in one channel node. */
const copyOf = (page: Page, agentId: string, channelId: string | null) =>
  page.locator(
    `[data-testid=org-node][data-agent-id="${agentId}"][data-key^="c:${channelId ?? "none"}"]`,
  )
const channelNode = (page: Page, channelId: string | null) =>
  page.locator(`[data-testid=org-channel][data-key="c:${channelId ?? "none"}"]`)

const center = async (target: Locator) => {
  const box = await target.boundingBox()
  if (!box) throw new Error("no box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
/** Presses on `from`, moves onto `to` in steps, and runs `during` before the drop. */
const drag = async (
  page: Page,
  from: Locator,
  to: { x: number; y: number },
  during?: () => Promise<void>,
) => {
  const start = await center(from)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 10, start.y + 10, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await during?.()
  await page.mouse.up()
}

test("edit on the org chart: menus, drag, Option, rings, refusal, Undo and Cmd+Z, keys", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 860)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    const server = await localServerId(page)
    const template = (await agentsOf(page))[0] as AgentInfo
    // Eve is in no channel, so the channel node "No channel" shows.
    for (const name of ["Bo", "Cy", "Dee", "Eve"]) {
      await rpc(page, "agents.create", {
        serverId: server,
        name,
        role: "",
        instructions: "",
        model: template.model,
      })
    }
    const ids = Object.fromEntries((await agentsOf(page)).map((a) => [a.name, a.id])) as Record<
      string,
      string
    >
    const docs = await rpc<ChannelInfo>(page, "channels.create", {
      serverId: server,
      name: "Docs",
      topic: "",
      memberIds: [ids.Ada, ids.Bo, ids.Cy],
      leadId: ids.Ada,
    })
    const ops = await rpc<ChannelInfo>(page, "channels.create", {
      serverId: server,
      name: "Ops",
      topic: "",
      memberIds: [ids.Dee],
      leadId: null,
    })
    const bo = ids.Bo as string
    const cy = ids.Cy as string

    await page.getByTestId("page-orgchart").click()
    await expect(page.getByTestId("org-canvas")).toBeVisible()
    await expect(copyOf(page, bo, docs.id)).toBeVisible()

    // Drag Bo from "Docs" onto "Ops": during the drag "Ops" and "No channel" show a ring, and
    // "Docs" (where Bo is) shows none. The drop moves Bo, and the line "Moved Bo to Ops." shows.
    await drag(
      page,
      copyOf(page, bo, docs.id),
      await center(channelNode(page, ops.id)),
      async () => {
        await expect(channelNode(page, ops.id)).toHaveAttribute("data-ring", "true")
        await expect(channelNode(page, null)).toHaveAttribute("data-ring", "true")
        await expect(channelNode(page, docs.id)).toHaveAttribute("data-ring", "false")
        await shot(page, "s108-01-drag-ring")
      },
    )
    await expect(page.getByTestId("org-notice-text")).toHaveText("Moved Bo to Ops.")
    await expect(page.getByTestId("org-undo")).toBeVisible()
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Cy", "Ops: Bo, Dee"])
    await expect(copyOf(page, bo, ops.id)).toBeVisible()
    await expect(copyOf(page, bo, docs.id)).toHaveCount(0)
    await shot(page, "s108-02-moved")

    // Undo: Bo is back in "Docs" only.
    await page.getByTestId("org-undo").click()
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo, Cy", "Ops: Dee"])
    await expect(copyOf(page, bo, docs.id)).toBeVisible()
    await expect(copyOf(page, bo, ops.id)).toHaveCount(0)

    // Drag with Option: Bo is added to "Ops" and stays in "Docs".
    await page.keyboard.down("Alt")
    await drag(
      page,
      copyOf(page, bo, docs.id),
      await center(channelNode(page, ops.id)),
      async () => {
        // With Option there is nothing to add to "No channel": it shows no ring.
        await expect(channelNode(page, null)).toHaveAttribute("data-ring", "false")
        await expect(channelNode(page, ops.id)).toHaveAttribute("data-ring", "true")
      },
    )
    await page.keyboard.up("Alt")
    await expect(page.getByTestId("org-notice-text")).toHaveText("Added Bo to Ops.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo, Cy", "Ops: Bo, Dee"])
    await expect(copyOf(page, bo, ops.id)).toBeVisible()
    await expect(copyOf(page, bo, docs.id)).toBeVisible()

    // Cmd+Z does what "Undo" does while the line shows.
    await page.keyboard.press("Meta+z")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo, Cy", "Ops: Dee"])

    // Escape ends a drag with no change. A drop on the empty canvas or on a node with no ring
    // changes nothing either.
    await drag(page, copyOf(page, cy, docs.id), await center(channelNode(page, ops.id)), () =>
      page.keyboard.press("Escape"),
    )
    const canvas = await page.getByTestId("org-canvas").boundingBox()
    if (!canvas) throw new Error("no canvas")
    await drag(page, copyOf(page, cy, docs.id), { x: canvas.x + 20, y: canvas.y + 20 })
    await drag(page, copyOf(page, cy, docs.id), await center(channelNode(page, docs.id)))
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo, Cy", "Ops: Dee"])
    // The drag opened nothing: the page is still the chart.
    await expect(page.getByTestId("org-canvas")).toBeVisible()

    // The keyboard: Shift+F10 on the focused node of Bo opens its menu; "Make lead of Docs"
    // makes Bo the lead. The menu key opens the same menu.
    await copyOf(page, bo, docs.id).focus()
    await page.keyboard.press("Shift+F10")
    const menu = page.getByTestId("org-menu")
    await expect(menu).toBeVisible()
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Open profile",
      "Make lead of Docs",
      "Add to channel…",
      "Move to channel…",
      "Remove from Docs",
    ])
    await shot(page, "s108-03-menu")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")
    await expect(page.getByTestId("org-notice-text")).toHaveText("Made Bo lead of Docs.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*, Cy", "Ops: Dee"])
    await expect(copyOf(page, bo, docs.id).getByTestId("org-lead-mark")).toHaveText("Lead")
    await expect(page.locator("[data-testid=org-line][data-kind=lead]")).toHaveCount(2)
    await expect(copyOf(page, bo, docs.id)).toBeFocused()
    // The menu key: "Remove as lead" on the lead.
    await page.keyboard.press("ContextMenu")
    await expect(menu.getByTestId("org-menu-unlead")).toHaveText("Remove as lead")
    await page.keyboard.press("Escape")
    await expect(menu).toHaveCount(0)
    await expect(copyOf(page, bo, docs.id)).toBeFocused()

    // "Move to channel…" with the keyboard: the list holds the channels where Bo is no member.
    await page.keyboard.press("Shift+F10")
    await menu.getByTestId("org-menu-move").focus()
    await page.keyboard.press("Enter")
    await expect(menu.getByRole("menuitem")).toHaveText(["Ops"])
    await page.keyboard.press("Enter")
    // A move of the lead leaves its channel with no lead.
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Cy", "Ops: Bo, Dee"])
    await expect(page.getByTestId("org-notice-text")).toHaveText("Moved Bo to Ops.")
    await page.getByTestId("org-undo").click()
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*, Cy", "Ops: Dee"])

    // The menu of a channel node: "Add member…" lists the agents that are not members.
    await channelNode(page, ops.id).click({ button: "right" })
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Open channel",
      "Add member…",
      "New agent in this channel",
      "Channel settings",
    ])
    await menu.getByTestId("org-menu-add-member").click()
    await expect(menu.getByRole("menuitem")).toHaveText(["Ada", "Bo", "Cy", "Eve"])
    await menu.getByTestId(`org-menu-member-${cy}`).click()
    await expect(page.getByTestId("org-notice-text")).toHaveText("Added Cy to Ops.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*, Cy", "Ops: Cy, Dee"])
    // "Remove from Ops" from the "…" button of the copy of Cy in "Ops".
    await copyOf(page, cy, ops.id).hover()
    const more = page.locator(
      `[data-testid=org-node-menu][data-key="${await copyOf(page, cy, ops.id).getAttribute("data-key")}"]`,
    )
    await expect(more).toHaveAttribute("data-shown", "true")
    await more.click()
    await menu.getByTestId("org-menu-remove").click()
    await expect(page.getByTestId("org-notice-text")).toHaveText("Removed Cy from Ops.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*, Cy", "Ops: Dee"])

    // The root "You" has no menu, and the node "No channel" has "New agent" only.
    await page.getByTestId("org-root").click({ button: "right" })
    await expect(menu).toHaveCount(0)
    await channelNode(page, null).click({ button: "right" })
    await expect(menu.getByRole("menuitem")).toHaveText(["New agent"])
    await page.keyboard.press("Escape")

    // A drop on "No channel" removes the agent from the channel it came from.
    await drag(page, copyOf(page, cy, docs.id), await center(channelNode(page, null)))
    await expect(page.getByTestId("org-notice-text")).toHaveText("Removed Cy from Docs.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*", "Ops: Dee"])
    await expect(copyOf(page, cy, null)).toBeVisible()
    // From "No channel", a drop on a channel node adds the agent.
    await drag(page, copyOf(page, cy, null), await center(channelNode(page, docs.id)))
    await expect(page.getByTestId("org-notice-text")).toHaveText("Added Cy to Docs.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*, Cy", "Ops: Dee"])

    // A member that works cannot leave its channel. Bo is the lead now; Ada leads again, and
    // gives Bo a part that runs long. A drag of Bo to "Ops" is refused and nothing changes.
    await rpc(page, "channels.update", { id: docs.id, patch: { leadId: ids.Ada } })
    await rpc(page, "channels.send", { channelId: docs.id, text: "split hold" })
    await expect(copyOf(page, bo, docs.id)).toHaveAttribute("data-state", "working", {
      timeout: 20_000,
    })
    await drag(page, copyOf(page, bo, docs.id), await center(channelNode(page, ops.id)))
    await expect(page.getByTestId("org-notice-text")).toHaveText(
      "Bo works in Docs. Wait for its part to end, or stop it.",
    )
    await expect(page.getByTestId("org-notice")).toHaveAttribute("data-kind", "refused")
    await expect(page.getByTestId("org-undo")).toHaveCount(0)
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo, Cy", "Ops: Dee"])
    await shot(page, "s108-04-refused")
    // The same in Korean. Names do not change.
    await rpc(page, "settings.update", { language: "ko" })
    await drag(page, copyOf(page, bo, docs.id), await center(channelNode(page, ops.id)))
    await expect(page.getByTestId("org-notice-text")).toContainText("Bo가 Docs에서 작업 중이에요")
    await shot(page, "s108-05-refused-korean")
    await rpc(page, "settings.update", { language: "en" })
    await rpc(page, "channels.stop", { channelId: docs.id })
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)

test("edit on the org chart of a linked computer with the switch Can create and change agents", async () => {
  test.setTimeout(240_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const two: Launched = await launch(freshUserData(), envFor(PORT_2))
  const one: Launched = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(one.app, 1300, 860)
    const serverTwo = await localServerId(two.page)
    for (const name of ["Ada", "Bo"])
      await rpc(two.page, "agents.create", {
        serverId: serverTwo,
        name,
        role: "",
        instructions: "",
      })
    const ids = Object.fromEntries((await agentsOf(two.page)).map((a) => [a.name, a.id])) as Record<
      string,
      string
    >
    const docs = await rpc<ChannelInfo>(two.page, "channels.create", {
      serverId: serverTwo,
      name: "Docs",
      topic: "",
      memberIds: [ids.Ada, ids.Bo],
      leadId: ids.Ada,
    })
    const ops = await rpc<ChannelInfo>(two.page, "channels.create", {
      serverId: serverTwo,
      name: "Ops",
      topic: "",
      memberIds: [ids.Ada],
      leadId: null,
    })
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

    await one.page.getByTestId("page-orgchart").click()
    await tile(one.page, "MacBook 2").click()
    await expect(one.page.getByTestId("org-canvas")).toBeVisible()
    const bo = copyOf(one.page, ids.Bo as string, docs.id)
    await expect(bo).toBeVisible()

    // A move on the chart works: Bo leaves "Docs" and joins "Ops" on MacBook 2.
    await drag(one.page, bo, await center(channelNode(one.page, ops.id)))
    await expect(one.page.getByTestId("org-notice-text")).toHaveText("Moved Bo to Ops.")
    await expect.poll(() => teams(two.page)).toEqual(["Docs: Ada*", "Ops: Ada, Bo"])
    await expect(copyOf(one.page, ids.Bo as string, ops.id)).toBeVisible()
    await shot(one.page, "s108-06-linked-moved")
    // Undo goes to MacBook 2 too.
    await one.page.getByTestId("org-undo").click()
    await expect.poll(() => teams(two.page)).toEqual(["Docs: Ada*, Bo", "Ops: Ada"])
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
  }
})
