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

// Spec 029, "Edit on the chart": the menus of the nodes, drag and drop with Option to add, the
// rings, an agent that works that still moves (membership holds no running work), the line with
// "Undo" and Cmd+Z, the keys for each edit, and a linked computer with the switch "Can create and
// change agents" (012). The chart edits organizations (030).

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}
interface OrgInfo {
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
const orgsOf = async (page: Page) =>
  rpc<OrgInfo[]>(page, "organizations.list", { serverId: await localServerId(page) })
/** The members of each organization by name, and its lead: "Docs: Ada*, Cy" (the lead has a star). */
const teams = async (page: Page) => {
  const names = new Map((await agentsOf(page)).map((a) => [a.id, a.name]))
  return (await orgsOf(page))
    .map(
      (c) =>
        `${c.name}: ${c.memberIds
          .map((m) => `${names.get(m)}${m === c.leadId ? "*" : ""}`)
          .sort()
          .join(", ")}`,
    )
    .sort()
}

/** The node of an agent in one organization node. */
const copyOf = (page: Page, agentId: string, orgId: string | null) =>
  page.locator(
    `[data-testid=org-node][data-agent-id="${agentId}"][data-key^="o:${orgId ?? "none"}"]`,
  )
const orgNode = (page: Page, orgId: string | null) =>
  page.locator(`[data-testid=org-unit][data-key="o:${orgId ?? "none"}"]`)

const center = async (target: Locator) => {
  const box = await target.boundingBox()
  if (!box) throw new Error("no box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
/** The view of the chart: pan and zoom. */
const viewOf = async (page: Page) => {
  const surface = page.getByTestId("org-surface")
  return {
    x: await surface.getAttribute("data-x"),
    y: await surface.getAttribute("data-y"),
    zoom: await surface.getAttribute("data-zoom"),
  }
}
const dropArea = (page: Page) => page.getByTestId("org-drop-area")
/** The view once the page has framed the chart and stopped. */
const settledView = async (page: Page) => {
  let last = ""
  await expect
    .poll(async () => {
      const now = JSON.stringify(await viewOf(page))
      const same = now === last
      last = now
      return same
    })
    .toBe(true)
  return viewOf(page)
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
    // Eve is in no organization, so the organization node "No organization" shows.
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
    const docs = await rpc<OrgInfo>(page, "organizations.create", {
      serverId: server,
      name: "Docs",
      memberIds: [ids.Ada, ids.Bo, ids.Cy],
      leadId: ids.Ada,
    })
    const ops = await rpc<OrgInfo>(page, "organizations.create", {
      serverId: server,
      name: "Ops",
      memberIds: [ids.Dee],
      leadId: null,
    })
    const bo = ids.Bo as string
    const cy = ids.Cy as string

    await page.getByTestId("page-orgchart").click()
    await expect(page.getByTestId("org-canvas")).toBeVisible()
    await expect(copyOf(page, bo, docs.id)).toBeVisible()

    // Drag Bo from "Docs" onto "Ops": during the drag "Ops", the drawn node "No organization" and the
    // drop area "No organization" show a ring, and "Docs" (where Bo is) shows none. The drop moves Bo,
    // and the line "Moved Bo to Ops." shows.
    await expect(dropArea(page)).toHaveCount(0)
    await drag(page, copyOf(page, bo, docs.id), await center(orgNode(page, ops.id)), async () => {
      await expect(orgNode(page, ops.id)).toHaveAttribute("data-ring", "true")
      await expect(orgNode(page, null)).toHaveAttribute("data-ring", "true")
      await expect(orgNode(page, docs.id)).toHaveAttribute("data-ring", "false")
      await expect(dropArea(page)).toHaveAttribute("data-ring", "true")
      await shot(page, "s108-01-drag-ring")
    })
    await expect(dropArea(page)).toHaveCount(0)
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
    await drag(page, copyOf(page, bo, docs.id), await center(orgNode(page, ops.id)), async () => {
      // With Option there is nothing to add to "No organization": it shows no ring.
      await expect(orgNode(page, null)).toHaveAttribute("data-ring", "false")
      await expect(dropArea(page)).toHaveAttribute("data-ring", "false")
      await expect(orgNode(page, ops.id)).toHaveAttribute("data-ring", "true")
    })
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
    await drag(page, copyOf(page, cy, docs.id), await center(orgNode(page, ops.id)), () =>
      page.keyboard.press("Escape"),
    )
    const canvas = await page.getByTestId("org-canvas").boundingBox()
    if (!canvas) throw new Error("no canvas")
    await drag(page, copyOf(page, cy, docs.id), { x: canvas.x + 20, y: canvas.y + 20 })
    await drag(page, copyOf(page, cy, docs.id), await center(orgNode(page, docs.id)))
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
      "Add to organization…",
      "Move to organization…",
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

    // "Move to organization…" with the keyboard: the list holds the organizations where Bo is no member.
    await page.keyboard.press("Shift+F10")
    await menu.getByTestId("org-menu-move").focus()
    await page.keyboard.press("Enter")
    await expect(menu.getByRole("menuitem")).toHaveText(["Ops"])
    await page.keyboard.press("Enter")
    // A move of the lead leaves its organization with no lead.
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Cy", "Ops: Bo, Dee"])
    await expect(page.getByTestId("org-notice-text")).toHaveText("Moved Bo to Ops.")
    await page.getByTestId("org-undo").click()
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*, Cy", "Ops: Dee"])

    // The menu of an organization node: "Add member…" lists the agents that are not members. "Put
    // under…" is there too (030); a top organization has no "Move to the top".
    await orgNode(page, ops.id).click({ button: "right" })
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Edit organization…",
      "Add member…",
      "New agent in this organization",
      "Put under…",
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

    // The root "You" has no menu, and the node "No organization" has "New agent" only.
    await page.getByTestId("org-root").click({ button: "right" })
    await expect(menu).toHaveCount(0)
    await orgNode(page, null).click({ button: "right" })
    await expect(menu.getByRole("menuitem")).toHaveText(["New agent"])
    await page.keyboard.press("Escape")

    // A drop on the drawn node "No organization" removes the agent from the organization it came from.
    await drag(page, copyOf(page, cy, docs.id), await center(orgNode(page, null)))
    await expect(page.getByTestId("org-notice-text")).toHaveText("Removed Cy from Docs.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*", "Ops: Dee"])
    await expect(copyOf(page, cy, null)).toBeVisible()
    // From "No organization", a drop on an organization node adds the agent. The drop area does not show:
    // the agent is in no organization.
    await drag(page, copyOf(page, cy, null), await center(orgNode(page, docs.id)), () =>
      expect(dropArea(page)).toHaveCount(0),
    )
    await expect(page.getByTestId("org-notice-text")).toHaveText("Added Cy to Docs.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada, Bo*, Cy", "Ops: Dee"])

    // An agent that works can still change its organizations: an organization holds no running
    // work (spec 029). Bo is the lead now; Ada leads again. A channel gives Bo a part that runs
    // long, and a drag of Bo to "Ops" moves Bo.
    await rpc(page, "organizations.update", { id: docs.id, patch: { leadId: ids.Ada } })
    const work = await rpc<{ id: string }>(page, "channels.create", {
      serverId: server,
      name: "Work",
      topic: "",
      memberIds: [ids.Ada, ids.Bo],
      leadId: ids.Ada,
    })
    await rpc(page, "channels.send", { channelId: work.id, text: "split hold" })
    await expect(copyOf(page, bo, docs.id)).toHaveAttribute("data-state", "working", {
      timeout: 20_000,
    })
    await drag(page, copyOf(page, bo, docs.id), await center(orgNode(page, ops.id)))
    await expect(page.getByTestId("org-notice-text")).toHaveText("Moved Bo to Ops.")
    await expect(page.getByTestId("org-notice")).toHaveAttribute("data-kind", "done")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Cy", "Ops: Bo, Dee"])
    await shot(page, "s108-04-working-agent-moves")
    // A line of a change shows for 10 seconds, and one line shows at a time.
    await expect(page.getByTestId("org-notice")).toHaveCount(1)
    // The same in Korean. Names do not change.
    await page.getByTestId("org-undo").click()
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo, Cy", "Ops: Dee"])
    await rpc(page, "settings.update", { language: "ko" })
    await drag(page, copyOf(page, bo, docs.id), await center(orgNode(page, ops.id)))
    await expect(page.getByTestId("org-notice-text")).toContainText("Bo")
    await expect(page.getByTestId("org-notice-text")).toContainText("Ops")
    await expect(page.getByTestId("org-notice-text")).toContainText("옮겼어요")
    await shot(page, "s108-05-moved-korean")
    await rpc(page, "settings.update", { language: "en" })
    await rpc(page, "channels.stop", { channelId: work.id })
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
    const docs = await rpc<OrgInfo>(two.page, "organizations.create", {
      serverId: serverTwo,
      name: "Docs",
      memberIds: [ids.Ada, ids.Bo],
      leadId: ids.Ada,
    })
    const ops = await rpc<OrgInfo>(two.page, "organizations.create", {
      serverId: serverTwo,
      name: "Ops",
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

    // A move on the chart works: Bo leaves "Docs" and joins "Ops" on MacBook 2. Every agent is
    // in an organization: the drag shows the drop area "No organization", and the view does not move.
    const before = await settledView(one.page)
    await drag(one.page, bo, await center(orgNode(one.page, ops.id)), async () => {
      await expect(dropArea(one.page)).toBeVisible()
      await expect(orgNode(one.page, null)).toHaveCount(0)
      expect(await viewOf(one.page)).toEqual(before)
    })
    await expect(one.page.getByTestId("org-notice-text")).toHaveText("Moved Bo to Ops.")
    await expect.poll(() => teams(two.page)).toEqual(["Docs: Ada*", "Ops: Ada, Bo"])
    await expect(copyOf(one.page, ids.Bo as string, ops.id)).toBeVisible()
    expect(await viewOf(one.page)).toEqual(before)
    await shot(one.page, "s108-06-linked-moved")
    // Undo goes to MacBook 2 too.
    await one.page.getByTestId("org-undo").click()
    await expect.poll(() => teams(two.page)).toEqual(["Docs: Ada*, Bo", "Ops: Ada"])
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
  }
})

test("edit on the org chart: the drop area No organization, a still view, edge scroll, Undone., and a new agent", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 860)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    const server = await localServerId(page)
    const template = (await agentsOf(page))[0] as AgentInfo
    for (const name of ["Bo", "Dee"]) {
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
    // Every agent is in an organization: the chart has no node "No organization".
    const docs = await rpc<OrgInfo>(page, "organizations.create", {
      serverId: server,
      name: "Docs",
      memberIds: [ids.Ada, ids.Bo],
      leadId: ids.Ada,
    })
    const ops = await rpc<OrgInfo>(page, "organizations.create", {
      serverId: server,
      name: "Ops",
      memberIds: [ids.Dee],
      leadId: null,
    })
    const bo = ids.Bo as string

    await page.getByTestId("page-orgchart").click()
    await expect(copyOf(page, bo, docs.id)).toBeVisible()
    await expect(orgNode(page, null)).toHaveCount(0)

    // During the drag of Bo, the drop area "No organization" shows at the bottom left of the canvas,
    // with a ring. The layout does not change: no node "No organization", the nodes stay in place, and
    // the view is the same. Escape ends the drag and the drop area goes.
    const before = await settledView(page)
    const opsAt = await center(orgNode(page, ops.id))
    const canvasBox = await page.getByTestId("org-canvas").boundingBox()
    if (!canvasBox) throw new Error("no canvas")
    await drag(page, copyOf(page, bo, docs.id), opsAt, async () => {
      await expect(dropArea(page)).toHaveAttribute("data-ring", "true")
      await expect(orgNode(page, null)).toHaveCount(0)
      const area = await dropArea(page).boundingBox()
      if (!area) throw new Error("no drop area")
      expect(area.x - canvasBox.x).toBeLessThan(40)
      expect(canvasBox.y + canvasBox.height - (area.y + area.height)).toBeLessThan(40)
      expect(await center(orgNode(page, ops.id))).toEqual(opsAt)
      expect(await viewOf(page)).toEqual(before)
      await shot(page, "s108-07-drag-drop-area")
      await page.keyboard.press("Escape")
    })
    await expect(dropArea(page)).toHaveCount(0)
    expect(await viewOf(page)).toEqual(before)
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo", "Ops: Dee"])

    // Edge scroll: while the pointer stays within 40 px of the top edge of the canvas, the view
    // moves down; the drop area stays where it is. The pointer goes back and Escape ends the drag.
    const areaBox = async () => JSON.stringify(await dropArea(page).boundingBox())
    await drag(page, copyOf(page, bo, docs.id), opsAt, async () => {
      await expect(dropArea(page)).toBeVisible()
      const fixed = await areaBox()
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 10, { steps: 4 })
      await expect
        .poll(async () => Number((await viewOf(page)).y))
        .toBeGreaterThan(Number(before.y) + 40)
      expect((await viewOf(page)).x).toBe(before.x)
      expect((await viewOf(page)).zoom).toBe(before.zoom)
      expect(await areaBox()).toBe(fixed)
      await page.mouse.move(opsAt.x, opsAt.y, { steps: 4 })
      await page.keyboard.press("Escape")
    })
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo", "Ops: Dee"])
    await page.getByTestId("org-fit").click()

    // No edge scroll on the drop area: the pointer stays on it, within 40 px of the bottom edge of
    // the canvas, and the view does not move. Escape ends the drag.
    const fitted = await settledView(page)
    await drag(page, copyOf(page, bo, docs.id), opsAt, async () => {
      const area = await dropArea(page).boundingBox()
      if (!area) throw new Error("no drop area")
      const nearBottom = {
        x: area.x + area.width / 2,
        y: Math.max(area.y + 2, canvasBox.y + canvasBox.height - 20),
      }
      expect(nearBottom.y).toBeLessThan(area.y + area.height)
      await page.mouse.move(nearBottom.x, nearBottom.y, { steps: 4 })
      await expect(dropArea(page)).toHaveAttribute("data-over", "true")
      await page.waitForTimeout(600)
      expect(await viewOf(page)).toEqual(fitted)
      await page.mouse.move(opsAt.x, opsAt.y, { steps: 4 })
      await page.keyboard.press("Escape")
    })
    expect(await viewOf(page)).toEqual(fitted)

    // A drop on the drop area removes Bo from "Docs". After the drag, "No organization" shows by the
    // normal rule: it holds Bo now.
    await drag(page, copyOf(page, bo, docs.id), opsAt, async () => {
      const to = await center(dropArea(page))
      await page.mouse.move(to.x, to.y, { steps: 4 })
      await expect(dropArea(page)).toHaveAttribute("data-over", "true")
    })
    await expect(page.getByTestId("org-notice-text")).toHaveText("Removed Bo from Docs.")
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*", "Ops: Dee"])
    await expect(copyOf(page, bo, null)).toBeVisible()

    // Undo: the line "Undone." takes its place, with no "Undo", for 3 seconds.
    await page.getByTestId("org-undo").click()
    await expect(page.getByTestId("org-notice-text")).toHaveText("Undone.")
    const undoneAt = Date.now()
    await expect(page.getByTestId("org-notice")).toHaveCount(1)
    await expect(page.getByTestId("org-undo")).toHaveCount(0)
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo", "Ops: Dee"])
    await expect(orgNode(page, null)).toHaveCount(0)
    await page.waitForTimeout(Math.max(0, undoneAt + 1_500 - Date.now()))
    await expect(page.getByTestId("org-notice")).toBeVisible()
    await expect(page.getByTestId("org-notice")).toHaveCount(0, { timeout: 3_000 })

    // "New agent in this organization": after the save the chart stays open, the profile does not
    // open, and the focus is on the node of the new agent in "Ops".
    await orgNode(page, ops.id).click({ button: "right" })
    await page.getByTestId("org-menu").getByTestId("org-menu-new-agent").click()
    await page.getByTestId("agent-name").fill("Fay")
    await page.getByTestId("model-model").waitFor()
    await page.getByTestId("agent-submit").click()
    await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
    await expect.poll(() => teams(page)).toEqual(["Docs: Ada*, Bo", "Ops: Dee, Fay"])
    const fay = (await agentsOf(page)).find((a) => a.name === "Fay")?.id as string
    await expect(copyOf(page, fay, ops.id)).toBeFocused()
    await expect(page.getByTestId("org-canvas")).toBeVisible()
    await expect(page.getByTestId("chat-start")).toHaveCount(0)
    await shot(page, "s108-08-new-agent-focused")

    // "New agent" on "No organization": take Fay out of "Ops" first, so that "No organization" shows.
    await rpc(page, "organizations.update", { id: ops.id, patch: { memberIds: [ids.Dee] } })
    await expect(copyOf(page, fay, null)).toBeVisible()
    await orgNode(page, null).click({ button: "right" })
    await page.getByTestId("org-menu").getByTestId("org-menu-new-agent").click()
    await page.getByTestId("agent-name").fill("Gus")
    await page.getByTestId("model-model").waitFor()
    await page.getByTestId("agent-submit").click()
    await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
    await expect.poll(async () => (await agentsOf(page)).some((a) => a.name === "Gus")).toBe(true)
    const gus = (await agentsOf(page)).find((a) => a.name === "Gus")?.id as string
    await expect(copyOf(page, gus, null)).toBeFocused()
    await expect(page.getByTestId("org-canvas")).toBeVisible()
    await expect(page.getByTestId("chat-start")).toHaveCount(0)

    // A new agent that is made but cannot join its organization: the organization is deleted while the form
    // is open. The refusal line gives the reason, and the focus goes to its node in "No organization".
    const tmp = await rpc<OrgInfo>(page, "organizations.create", {
      serverId: server,
      name: "Tmp",
      memberIds: [ids.Dee],
      leadId: null,
    })
    await orgNode(page, tmp.id).click({ button: "right" })
    await page.getByTestId("org-menu").getByTestId("org-menu-new-agent").click()
    await page.getByTestId("agent-name").fill("Ivy")
    await page.getByTestId("model-model").waitFor()
    await rpc(page, "organizations.delete", { id: tmp.id })
    await page.getByTestId("agent-submit").click()
    await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
    await expect(page.getByTestId("org-notice-text")).toHaveText(
      "Ivy is made, but cannot join the organization. That organization does not exist any more.",
    )
    await expect(page.getByTestId("org-notice")).toHaveAttribute("data-kind", "refused")
    const ivy = (await agentsOf(page)).find((a) => a.name === "Ivy")?.id as string
    await expect(copyOf(page, ivy, null)).toBeFocused()
    await shot(page, "s108-09-new-agent-cannot-join")

    // The New agent form elsewhere (002) still opens the new agent.
    await createAgent(page, "Hal")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})
