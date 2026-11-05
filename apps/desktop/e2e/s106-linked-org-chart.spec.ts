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
import { closeSettings, envFor, openDevices, rpc, setName } from "./sync-helpers.ts"

// Spec 029 and 012: the org chart of a linked computer. MacBook 1 (the client) opens the Org chart
// page of MacBook 2 (the server) with only the link: the switch "Can create and change agents" is
// off. The chart is the chart of MacBook 2, read only, and it follows MacBook 2 within a second.
// With MacBook 2 off the page shows "MacBook 2 is offline." and no chart; when MacBook 2 is back
// the chart comes back by itself. Two copies of the app run side by side with their own data.

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const nodeOf = (page: Page, name: string) =>
  page
    .getByTestId("org-node")
    .filter({ has: page.getByTestId("org-name").getByText(name, { exact: true }) })
const orgOf = (page: Page, name: string) => page.getByTestId("org-unit").filter({ hasText: name })

/** MacBook 2 shows a code; MacBook 1 connects one way, and MacBook 2 leaves the switch off. */
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
  await two.page.getByTestId("join-can-change").click() // the switch is on at first: turn it off
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}
const localServerId = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", {
    serverId: await localServerId(page),
    archived: false,
  })

/** Ada works on a long task. The stand-in model answers "run long" in about 30 seconds. */
const LONG_WORK = "Draft the release notes (run long)"

test("linked org chart: the chart of the server, read only, live, with an offline line", async () => {
  test.setTimeout(300_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const mock = await startMockProvider()
  const data2 = freshUserData()
  let two: Launched = await launch(data2, envFor(PORT_2))
  const one: Launched = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(two.app, 1300, 860)
    await resizeWindow(one.app, 1300, 860)

    // MacBook 2 has the agents: Ada (lead) and Bo in the organization "Docs", and Dee in no organization.
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(two.page, "Ada")
    const serverTwo = await localServerId(two.page)
    const template = (await agentsOf(two.page))[0] as AgentInfo
    for (const [name, role] of [
      ["Bo", "Writes the first draft of every article"],
      ["Dee", "Keeps the calendar"],
    ] as const) {
      await rpc(two.page, "agents.create", {
        serverId: serverTwo,
        name,
        role,
        instructions: "",
        model: template.model,
      })
    }
    const ids = Object.fromEntries((await agentsOf(two.page)).map((a) => [a.name, a.id]))
    await rpc(two.page, "organizations.create", {
      serverId: serverTwo,
      name: "Docs",
      memberIds: [ids.Ada, ids.Bo],
      leadId: ids.Ada,
    })
    // MacBook 1 has its own agent. It must never show in the chart of MacBook 2.
    await rpc(one.page, "agents.create", {
      serverId: await localServerId(one.page),
      name: "Zed",
      role: "Lives on MacBook 1",
      instructions: "",
    })

    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)
    await pairOneWay(one, two)
    await closeSettings(two.page)

    // The chart of MacBook 1 itself still shows its own agent, and none of MacBook 2.
    await one.page.getByTestId("page-orgchart").click()
    await expect(nodeOf(one.page, "Zed")).toBeVisible()
    await expect(nodeOf(one.page, "Ada")).toHaveCount(0)

    // The chart of MacBook 2 on MacBook 1: it needs only the link. The old line "Open this on
    // MacBook 2." is gone, and the chart is the chart of MacBook 2.
    await tile(one.page, "MacBook 2").click()
    await expect(one.page.getByTestId("org-canvas")).toBeVisible()
    await expect(one.page.getByTestId("page-open-on-server")).toHaveCount(0)
    await expect(one.page.getByTestId("org-open-on-server")).toHaveCount(0)
    await expect(one.page.getByTestId("org-node")).toHaveCount(3)
    await expect(nodeOf(one.page, "Ada")).toBeVisible()
    await expect(nodeOf(one.page, "Zed")).toHaveCount(0)
    await expect(one.page.getByTestId("org-root")).toHaveAttribute("aria-label", "You")
    const docs = orgOf(one.page, "Docs")
    await expect(docs.getByTestId("org-unit-members")).toHaveText("2 members")
    await expect(docs.getByTestId("org-unit-states")).toHaveText("2 idle")
    await expect(orgOf(one.page, "No organization").getByTestId("org-unit-members")).toHaveText(
      "1 member",
    )
    await expect(nodeOf(one.page, "Ada").getByTestId("org-lead-mark")).toHaveText("Lead")
    await expect(nodeOf(one.page, "Bo").getByTestId("org-role")).toHaveText(
      "Writes the first draft of every article",
    )
    const lines = (kind: string) => one.page.locator(`[data-testid=org-line][data-kind=${kind}]`)
    await expect(lines("lead")).toHaveCount(1)
    // "Belongs to": the root to both organization nodes, "Docs" to its lead, "No organization" to Dee.
    await expect(lines("structure")).toHaveCount(4)
    await expect(one.page.getByTestId("org-legend")).toContainText("Leads")
    // Read only: no control to make or change anything, and the switch is off for this device.
    await expect(one.page.getByTestId("org-new-agent")).toHaveCount(0)
    await expect(one.page.getByTestId("new-agent")).toHaveCount(0)
    await expect(one.page.getByTestId("org-canvas").locator("input, textarea, select")).toHaveCount(
      0,
    )
    await shot(one.page, "s106-01-linked-chart")

    // Without the switch, the menus hold no change and there is no drag (spec 029, S108).
    const menu = one.page.getByTestId("org-menu")
    await nodeOf(one.page, "Bo").click({ button: "right" })
    await expect(menu.getByRole("menuitem")).toHaveText(["Open profile"])
    await one.page.keyboard.press("Escape")
    await orgOf(one.page, "Docs").click({ button: "right" })
    // The form opens read only: "Edit organization…" is no change (spec 012, 029).
    await expect(menu.getByRole("menuitem")).toHaveText(["Edit organization…"])
    await one.page.keyboard.press("Escape")
    await orgOf(one.page, "No organization").click({ button: "right" })
    await expect(menu).toHaveCount(0)
    const from = await nodeOf(one.page, "Bo").boundingBox()
    const to = await orgOf(one.page, "No organization").boundingBox()
    if (!from || !to) throw new Error("no box")
    await one.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await one.page.mouse.down()
    await one.page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
    await expect(orgOf(one.page, "No organization")).toHaveAttribute("data-ring", "false")
    await one.page.mouse.up()
    await expect(one.page.getByTestId("org-notice")).toHaveCount(0)
    const stored = await rpc<{ name: string; memberIds: string[] }[]>(
      two.page,
      "organizations.list",
      { serverId: serverTwo },
    )
    expect(stored.find((c) => c.name === "Docs")?.memberIds).toEqual([ids.Ada, ids.Bo])

    // A click on an agent node opens that agent on MacBook 2; a click on an organization node
    // opens the form of that organization, read only. The server tile stays MacBook 2.
    await nodeOf(one.page, "Bo").click()
    await expect(one.page.getByTestId("chat-header-agent")).toContainText("Bo")
    await expect(one.page.getByTestId("agent-profile")).toBeVisible()
    await shot(one.page, "s106-02-linked-profile")
    await one.page.keyboard.press("Escape")
    await one.page.getByTestId("page-orgchart").click()
    await expect(one.page.getByTestId("org-canvas")).toBeVisible()
    await orgOf(one.page, "Docs").click()
    await expect(one.page.getByTestId("org-dialog")).toBeVisible()
    await expect(one.page.getByTestId("org-readonly")).toBeVisible()
    await expect(one.page.getByTestId("org-form").getByTestId("org-name")).not.toBeEditable()
    await expect(one.page.getByTestId("org-submit")).toHaveCount(0)
    await shot(one.page, "s106-03-linked-form-readonly")
    await one.page.keyboard.press("Escape")
    await expect(one.page.getByTestId("org-dialog")).toHaveCount(0)
    // The button "New organization" is not on the chart without the switch.
    await expect(one.page.getByTestId("org-new")).toHaveCount(0)

    // A task starts on MacBook 2: the node of Ada shows "working" and the label on MacBook 1
    // within 1 second of the moment that MacBook 2 itself knows it.
    await rpc(two.page, "chat.send", { agentId: ids.Ada, text: LONG_WORK, replyTo: null })
    await expect
      .poll(
        async () =>
          (
            await rpc<{ agents: { id: string; state: string }[] }>(two.page, "orgChart.get")
          ).agents.find((a) => a.id === ids.Ada)?.state,
        { timeout: 15_000 },
      )
      .toBe("working")
    await expect(nodeOf(one.page, "Ada")).toHaveAttribute("data-state", "working", {
      timeout: 1000,
    })
    await expect(nodeOf(one.page, "Ada").getByTestId("org-task-label")).toHaveText(LONG_WORK, {
      timeout: 1000,
    })
    await expect(nodeOf(one.page, "Ada").getByTestId("org-state")).toContainText("Working")
    await expect(docs.getByTestId("org-unit-states")).toHaveText("1 working · 1 idle", {
      timeout: 1000,
    })
    await shot(one.page, "s106-03-linked-working")

    // A change of a role line on MacBook 2 shows within 1 second, and the zoom of the user stays.
    await one.page.getByTestId("org-zoom-in").click()
    const surface = one.page.getByTestId("org-surface")
    await expect(surface).not.toHaveAttribute("data-zoom", "1.000")
    const zoomed = await surface.getAttribute("data-zoom")
    await rpc(two.page, "agents.update", { id: ids.Dee, patch: { role: "Plans trips" } })
    await expect(nodeOf(one.page, "Dee").getByTestId("org-role")).toHaveText("Plans trips", {
      timeout: 1000,
    })
    await expect(surface).toHaveAttribute("data-zoom", zoomed ?? "")

    // Korean: the legend and the counts are Korean; names and the task label are not.
    await rpc(one.page, "settings.update", { language: "ko" })
    await expect(one.page.getByTestId("org-legend")).toContainText("이끌어요")
    await expect(docs.getByTestId("org-unit-members")).toHaveText("멤버 2명")
    await expect(nodeOf(one.page, "Ada").getByTestId("org-task-label")).toHaveText(LONG_WORK)
    await shot(one.page, "s106-04-linked-chart-korean")

    // MacBook 2 goes off: the page shows the line "MacBook 2 is offline." and no chart. Nothing of
    // the chart stays in the page.
    await rpc(two.page, "chat.stop", { agentId: ids.Ada })
    await rpc(one.page, "settings.update", { language: "en" })
    await expect(one.page.getByTestId("org-legend")).toContainText("Leads")
    await two.app.close()
    await expect(one.page.getByTestId("org-offline")).toHaveText("MacBook 2 is offline.", {
      timeout: 60_000,
    })
    await expect(one.page.getByTestId("org-canvas")).toHaveCount(0)
    await expect(one.page.getByTestId("org-node")).toHaveCount(0)
    await expect(one.page.getByTestId("org-unit")).toHaveCount(0)
    await expect(one.page.getByTestId("org-legend")).toHaveCount(0)
    await expect(one.page.getByTestId("org-page")).not.toContainText("Ada")
    await expect(one.page.getByTestId("org-page")).not.toContainText("Docs")
    await shot(one.page, "s106-05-linked-offline")
    // The Korean line for the same state.
    await rpc(one.page, "settings.update", { language: "ko" })
    await expect(one.page.getByTestId("org-offline")).toContainText("MacBook 2")
    await shot(one.page, "s106-06-linked-offline-korean")
    await rpc(one.page, "settings.update", { language: "en" })
    await expect(one.page.getByTestId("org-offline")).toHaveText("MacBook 2 is offline.")

    // MacBook 2 comes back: the chart comes back by itself, with no new pairing and no reload.
    two = await launch(data2, envFor(PORT_2))
    await resizeWindow(two.app, 1300, 860)
    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online", {
      timeout: 60_000,
    })
    await expect(one.page.getByTestId("org-canvas")).toBeVisible()
    await expect(one.page.getByTestId("org-offline")).toHaveCount(0)
    await expect(one.page.getByTestId("org-node")).toHaveCount(3)
    await expect(nodeOf(one.page, "Ada")).toHaveAttribute("data-state", "idle")
    await shot(one.page, "s106-07-linked-back")
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
