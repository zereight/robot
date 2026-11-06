import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The org chart (spec 029): four agents, one organization "Docs" with a lead, one hand-off from Bo to
// Cy, and one task that runs. The test reads the page, checks that nothing overlaps or is cut off
// with "reduce motion" on and off, uses the keys and the pointer, and follows live changes.

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}
interface OrgSnapshotInfo {
  handoffs: { from: string; to: string; count: number }[]
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await serverOf(page), archived: false })
const idOf = async (page: Page, name: string) =>
  (await agentsOf(page)).find((a) => a.name === name)?.id as string

/** Ada works on a long task. The stand-in model answers "run long" in about 30 seconds. */
const LONG_WORK = "Draft the release notes (run long)"
const keepWorking = async (page: Page, agentId: string) => {
  const node = nodeOf(page, "Ada")
  if ((await node.count()) > 0 && (await node.getAttribute("data-state")) === "working") return
  await rpc(page, "chat.send", { agentId, text: LONG_WORK, replyTo: null })
  await expect(node).toHaveAttribute("data-state", "working", { timeout: 10_000 })
}

const nodeOf = (page: Page, name: string) =>
  page
    .getByTestId("org-node")
    .filter({ has: page.getByTestId("org-name").getByText(name, { exact: true }) })
const orgOf = (page: Page, name: string) => page.getByTestId("org-unit").filter({ hasText: name })

/** The faults of the drawing in words: nodes that overlap, a number on a node, text that is cut. */
const faultsOf = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = []
    const q = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
    const nodes = q(
      '[data-testid="org-node"],[data-testid="org-root"],[data-testid="org-unit"],[data-testid="org-more"]',
    )
    const pills = q('[data-testid="org-line-count"]')
    const name = (el: HTMLElement) => el.getAttribute("aria-label") ?? el.dataset.key ?? "?"
    const hit = (a: DOMRect, b: DOMRect) =>
      a.left < b.right - 0.5 &&
      b.left < a.right - 0.5 &&
      a.top < b.bottom - 0.5 &&
      b.top < a.bottom - 0.5
    const boxes = [...nodes, ...pills].map((el) => ({ el, rect: el.getBoundingClientRect() }))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (a && b && hit(a.rect, b.rect)) found.push(`overlap: ${name(a.el)} / ${name(b.el)}`)
      }
    }
    for (const node of nodes) {
      // The text of a node stays inside it, and a node does not hide a second line.
      if (node.scrollHeight > node.clientHeight + 1)
        found.push(`cut at the bottom: ${name(node)} (${node.scrollHeight} > ${node.clientHeight})`)
      const box = node.getBoundingClientRect()
      for (const part of node.querySelectorAll<HTMLElement>("[data-testid^=org-]")) {
        const r = part.getBoundingClientRect()
        if (r.width === 0) continue
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5)
          found.push(`outside its node: ${part.dataset.testid} of ${name(node)}`)
      }
      // A line that must show whole (the state, the members, the counts) is not cut with "…".
      for (const part of node.querySelectorAll<HTMLElement>(
        '[data-testid="org-state"] span,[data-testid="org-unit-members"],[data-testid="org-unit-states"]',
      )) {
        if (part.scrollWidth > part.clientWidth + 1 && part.clientWidth > 0)
          found.push(`cut at the side: ${part.textContent} of ${name(node)}`)
      }
    }
    return found
  })

/** Waits until the motion of the view has ended: no transition runs on the surface. */
const settled = (page: Page) =>
  expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest?.("[data-animate]"))
            .length,
      ),
    )
    .toBe(0)

/** Where each node sits in the chart (not on the screen), so that two views can be compared. */
const positionsOf = async (page: Page) => {
  await settled(page)
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-testid="org-surface"]')
    const zoom = Number(surface?.dataset.zoom ?? 1)
    const origin = surface?.getBoundingClientRect()
    return Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>("[data-node]")].map((el) => {
        const r = el.getBoundingClientRect()
        return [
          el.dataset.key,
          [
            Math.round((r.left - (origin?.left ?? 0)) / zoom),
            Math.round((r.top - (origin?.top ?? 0)) / zoom),
          ],
        ]
      }),
    )
  })
}

const view = async (page: Page) => {
  const surface = page.getByTestId("org-surface")
  return {
    zoom: Number(await surface.getAttribute("data-zoom")),
    x: Number(await surface.getAttribute("data-x")),
    y: Number(await surface.getAttribute("data-y")),
  }
}

/**
 * Waits until the canvas has its last size and the view has followed it: the size and the view are
 * the same in samples that are 250 ms apart. The size can change for a moment when the page opens
 * (the activity panel leaves), and the page frames the chart again for each size.
 */
const frameSettled = async (page: Page) => {
  const sample = async () => {
    const box = await page.getByTestId("org-canvas").boundingBox()
    return JSON.stringify([box?.width, box?.height, await view(page)])
  }
  let last = await sample()
  await expect
    .poll(async () => {
      await page.waitForTimeout(250)
      const now = await sample()
      const same = now === last
      last = now
      return same
    })
    .toBe(true)
}

/** True when the node is whole inside the canvas and not under the controls. */
const framed = async (page: Page, nodes: Locator) => {
  const canvas = await page.getByTestId("org-canvas").boundingBox()
  const controls = await page.getByTestId("org-controls").boundingBox()
  if (!canvas || !controls) return false
  for (const box of await Promise.all((await nodes.all()).map((n) => n.boundingBox()))) {
    if (!box) return false
    if (box.x < canvas.x || box.y < canvas.y) return false
    if (box.x + box.width > canvas.x + canvas.width) return false
    if (box.y + box.height > canvas.y + canvas.height) return false
    const under =
      box.x < controls.x + controls.width &&
      controls.x < box.x + box.width &&
      box.y < controls.y + controls.height &&
      controls.y < box.y + box.height
    if (under) return false
  }
  return true
}

test("org chart: nodes, lines, counts, hover, keys, live changes, no overlap with reduce motion on and off", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)

  // No agent: no canvas, one muted line and the button "New agent".
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-empty")).toContainText("No agents yet.")
  await expect(page.getByTestId("org-new-agent")).toBeVisible()
  await expect(page.getByTestId("org-canvas")).toHaveCount(0)
  await shot(page, "org-01-empty")

  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await page.getByTestId("page-chats").click()
  await createAgent(page, "Ada")
  const template = (await agentsOf(page))[0] as AgentInfo
  const server = await serverOf(page)
  for (const [name, role] of [
    ["Bo", "Writes the first draft of every article"],
    ["Cy", "Checks facts"],
    ["Dee", "Keeps the calendar"],
  ] as const) {
    await rpc(page, "agents.create", {
      serverId: server,
      name,
      role,
      instructions: "",
      model: template.model,
    })
  }
  const [ada, bo, cy] = await Promise.all(["Ada", "Bo", "Cy"].map((n) => idOf(page, n)))
  await rpc(page, "organizations.create", {
    serverId: server,
    name: "Docs",
    memberIds: [ada, bo, cy],
    leadId: ada,
  })

  // One hand-off: Bo sends a message to Cy with the tool "send message". The reply of Cy comes
  // back to Bo and is no hand-off.
  await rpc(page, "chat.send", {
    agentId: bo,
    text: 'TOOL send_message {"to":"Cy","text":"Please check the facts"}',
    replyTo: null,
  })
  await expect
    .poll(
      async () =>
        (await rpc<{ source: string; state: string }[]>(page, "tasks.list", { serverId: server }))
          .filter((t) => t.source === "agent")
          .map((t) => t.state)
          .sort()
          .join(","),
      { timeout: 30_000 },
    )
    .toBe("done,done")
  const snapshot = await rpc<OrgSnapshotInfo>(page, "orgChart.get")
  expect(snapshot.handoffs).toEqual([expect.objectContaining({ from: bo, to: cy, count: 1 })])

  // One task that runs: Ada works on a long task.
  await rpc(page, "chat.send", { agentId: ada, text: LONG_WORK, replyTo: null })
  await expect.poll(async () => (await agentsOf(page)).length, { timeout: 5000 }).toBe(4)
  const before = await rpc<unknown[]>(page, "tasks.list", { serverId: server })

  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-canvas")).toBeVisible()
  const adaNode = nodeOf(page, "Ada")
  await keepWorking(page, ada as string)

  // The root is "You": no main agent exists. The organization node "Docs" holds three members, and the
  // node "No organization" holds the fourth agent.
  await expect(page.getByTestId("org-root")).toHaveAttribute("aria-label", "You")
  await expect(page.getByTestId("org-unit")).toHaveCount(2)
  const docs = orgOf(page, "Docs")
  await expect(docs.getByTestId("org-unit-members")).toHaveText("3 members")
  await expect(docs.getByTestId("org-unit-states")).toHaveText("1 working · 2 idle")
  const none = orgOf(page, "No organization")
  await expect(none.getByTestId("org-unit-members")).toHaveText("1 member")
  await expect(page.getByTestId("org-node")).toHaveCount(4)

  // The lead has the mark "Lead" and its task label. The others have none of both.
  await expect(adaNode.getByTestId("org-lead-mark")).toHaveText("Lead")
  await expect(page.getByTestId("org-lead-mark")).toHaveCount(1)
  await expect(adaNode.getByTestId("org-task-label")).toContainText(
    "Draft the release notes (run long)",
  )
  await expect(adaNode.getByTestId("org-state")).toContainText("Working")
  await expect(nodeOf(page, "Bo").getByTestId("org-role")).toHaveText(
    "Writes the first draft of every article",
  )
  await expect(nodeOf(page, "Bo").getByTestId("org-state")).toContainText("Idle")
  await expect(nodeOf(page, "Bo").getByTestId("org-task-label")).toHaveCount(0)

  // The lines: two lead lines (Ada to Bo and Cy), one hand-off line with the number 1, and four
  // lines of "belongs to": the root to both organization nodes, "Docs" to its lead, and "No organization"
  // to Dee (it has no lead).
  const lines = (kind: string) => page.locator(`[data-testid=org-line][data-kind=${kind}]`)
  await expect(lines("lead")).toHaveCount(2)
  await expect(lines("handoff")).toHaveCount(1)
  await expect(lines("structure")).toHaveCount(4)
  await expect(page.getByTestId("org-line-count")).toHaveText("1")
  await expect(page.getByTestId("org-legend")).toContainText("Leads")
  await expect(page.getByTestId("org-legend")).toContainText("Handed work in the last 7 days")
  await expect(page.getByTestId("org-legend")).toContainText("Belongs to")
  await expect(page.getByTestId("org-capped")).toHaveCount(0)

  // The page opened fitted: every node is whole in the canvas and not under the controls.
  await expect.poll(() => framed(page, page.locator("[data-node]"))).toBe(true)
  // The view of the open page is the view of "Fit to view": the size of the canvas can change while
  // the page opens (the activity panel leaves), and the chart is framed again for it.
  await frameSettled(page)
  const opened = await view(page)
  await page.getByTestId("org-fit").click()
  await settled(page)
  const fittedAgain = await view(page)
  expect(fittedAgain.zoom).toBeCloseTo(opened.zoom, 2)
  expect(fittedAgain.x).toBeCloseTo(opened.x, 0)
  expect(fittedAgain.y).toBeCloseTo(opened.y, 0)
  expect(await faultsOf(page)).toEqual([])
  await shot(page, "org-02-chart-motion-default")

  // Pointing at the number of the hand-off line shows the note.
  await page.getByTestId("org-line-count").hover()
  await expect(page.getByTestId("org-line-tip")).toHaveText(
    "Bo handed 1 task to Cy in the last 7 days.",
  )
  await page.mouse.move(5, 5)
  await expect(page.getByTestId("org-line-tip")).toHaveCount(0)

  // Pointing at Bo lights its own lines and the nodes at their ends: the lead (lead line) and Cy
  // (hand-off line). The organization node "Docs" has a line to its lead only, so it dims with the
  // root, "No organization" and Dee. Moving away clears the dim.
  await nodeOf(page, "Bo").hover()
  await expect(nodeOf(page, "Dee")).toHaveAttribute("data-dim", "true")
  await expect(none).toHaveAttribute("data-dim", "true")
  await expect(docs).toHaveAttribute("data-dim", "true")
  await expect(page.getByTestId("org-root")).toHaveAttribute("data-dim", "true")
  await expect(nodeOf(page, "Bo")).toHaveAttribute("data-dim", "false")
  await expect(adaNode).toHaveAttribute("data-dim", "false")
  await expect(nodeOf(page, "Cy")).toHaveAttribute("data-dim", "false")
  await shot(page, "org-03-hover-bo")
  await page.mouse.move(5, 5)
  await expect(page.locator("[data-node][data-dim=true]")).toHaveCount(0)

  // Zoom and pan keep their place when an agent changes: the role line of Dee changes and so
  // does the label of a task; the view stays.
  await page.getByTestId("org-zoom-in").click()
  await expect.poll(async () => (await view(page)).zoom).toBeGreaterThan(0)
  const zoomed = await view(page)
  const surface = page.getByTestId("org-surface")
  await rpc(page, "agents.update", { id: await idOf(page, "Dee"), patch: { role: "Plans trips" } })
  await expect(nodeOf(page, "Dee").getByTestId("org-role")).toHaveText("Plans trips", {
    timeout: 1500,
  })
  expect(await view(page)).toEqual(zoomed)
  await expect(surface).toHaveAttribute("data-zoom", zoomed.zoom.toFixed(3))

  // The keys: "-" zooms out, "+" zooms in, "0" fits the view.
  await page.getByTestId("org-canvas").click({ position: { x: 4, y: 4 } })
  await page.keyboard.press("-")
  await expect.poll(async () => (await view(page)).zoom).toBeLessThan(zoomed.zoom)
  await page.keyboard.press("0")
  await expect.poll(async () => (await view(page)).zoom).toBeLessThanOrEqual(1)
  await expect.poll(() => framed(page, page.locator("[data-node]"))).toBe(true)

  // Dragging the empty canvas moves the view; a node does not move.
  const fitted = await view(page)
  const positions = await positionsOf(page)
  await page.mouse.move(8, 400)
  const canvasBox = (await page.getByTestId("org-canvas").boundingBox()) as {
    x: number
    y: number
    width: number
  }
  await page.mouse.move(canvasBox.x + 6, canvasBox.y + 6)
  await page.mouse.down()
  await page.mouse.move(canvasBox.x + 66, canvasBox.y + 46, { steps: 4 })
  await page.mouse.up()
  const moved = await view(page)
  expect(Math.round(moved.x - fitted.x)).toBe(60)
  expect(Math.round(moved.y - fitted.y)).toBe(40)
  expect(await positionsOf(page)).toEqual(positions)
  await page.keyboard.press("0")
  await expect.poll(async () => (await view(page)).x).toBeCloseTo(fitted.x, 0)

  // The wheel moves the view. A pinch (the wheel with the control key) zooms around the pointer.
  await page.mouse.move(canvasBox.x + 300, canvasBox.y + 200)
  await page.mouse.wheel(0, 50)
  await expect.poll(async () => Math.round((await view(page)).y - fitted.y)).toBe(-50)
  expect((await view(page)).zoom).toBeCloseTo(fitted.zoom, 5)
  await page.getByTestId("org-fit").click()
  await page.keyboard.down("Control")
  await page.mouse.wheel(0, -200)
  await page.keyboard.up("Control")
  await expect.poll(async () => (await view(page)).zoom).toBeGreaterThan(fitted.zoom)
  await page.getByTestId("org-fit").click()
  await expect.poll(async () => (await view(page)).zoom).toBeCloseTo(fitted.zoom, 2)

  // Tab goes through the nodes in the order of the page: the root, then each organization node and
  // its agents. Escape clears the dim that the focus makes. Enter opens the profile.
  await page.getByTestId("org-canvas").click({ position: { x: 4, y: 4 } })
  const order: string[] = []
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press("Tab")
    order.push(
      await page.evaluate(
        () => document.activeElement?.getAttribute("aria-label")?.split(". ")[0] ?? "?",
      ),
    )
  }
  expect(order).toEqual(["You", "Docs", "Ada", "Bo", "Cy", "No organization", "Dee"])
  await expect(page.locator("[data-node][data-dim=true]")).not.toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.locator("[data-node][data-dim=true]")).toHaveCount(0)
  // The focus keeps its place while the chart changes.
  await rpc(page, "agents.update", { id: await idOf(page, "Dee"), patch: { role: "Plans" } })
  await expect(nodeOf(page, "Dee").getByTestId("org-role")).toHaveText("Plans", { timeout: 1500 })
  await expect(nodeOf(page, "Dee")).toBeFocused()

  // The accessible names: Ada is the lead and works; Bo handed work to one agent; Cy got work.
  await keepWorking(page, ada as string)
  const nameOf = async (node: Locator) => (await node.getAttribute("aria-label")) ?? ""
  expect(await nameOf(adaNode)).toBe("Ada. Working. Lead. Draft the release notes (run long)")
  expect(await nameOf(nodeOf(page, "Bo"))).toBe(
    "Bo. Writes the first draft of every article. Idle. Handed work to 1 agent",
  )
  expect(await nameOf(nodeOf(page, "Cy"))).toBe("Cy. Checks facts. Idle. Got work from 1 agent")
  // The line of the outcome of the members in the last 7 days (spec 029, "Organization node"): the
  // tasks of Ada, Bo and Cy that ended as done. The task of Ada that still runs does not count.
  const done = (
    await rpc<{ state: string; agentId: string }[]>(page, "tasks.list", { serverId: server })
  ).filter((t) => t.state === "done" && [ada, bo, cy].includes(t.agentId)).length
  expect(await nameOf(docs)).toBe(`Docs. 3 members. 1 working, 2 idle. ${done} done`)

  // A click on an agent node opens the profile; a click on an organization node opens its form.
  await page.getByTestId("page-orgchart").click()
  await nodeOf(page, "Bo").press("Enter")
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Bo")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await page.getByTestId("page-orgchart").click()
  await orgOf(page, "Docs").click()
  await expect(page.getByTestId("org-dialog")).toBeVisible()
  await expect(page.getByTestId("org-form").getByTestId("org-name")).toHaveValue("Docs")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("org-dialog")).toHaveCount(0)
  // The node "No organization" does nothing.
  await orgOf(page, "No organization").click()
  await expect(page.getByTestId("org-dialog")).toHaveCount(0)
  await expect(page.getByTestId("org-canvas")).toBeVisible()

  // The page makes no task and starts no turn: the list of tasks has not grown.
  expect((await rpc<unknown[]>(page, "tasks.list", { serverId: server })).length).toBe(
    before.length,
  )

  // Positions do not depend on motion: the same chart with "reduce motion" on and off.
  await keepWorking(page, ada as string)
  await expect.poll(() => framed(page, page.locator("[data-node]"))).toBe(true)
  await rpc(page, "settings.update", { reduceMotion: "off" })
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "false")
  await expect.poll(() => framed(page, page.locator("[data-node]"))).toBe(true)
  const withMotion = await positionsOf(page)
  expect(await faultsOf(page)).toEqual([])
  await shot(page, "org-04-reduce-motion-off")
  await rpc(page, "settings.update", { reduceMotion: "on" })
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true")
  await page.getByTestId("org-zoom-out").click()
  // With reduce motion on, nothing moves: the view changes at once, with no transition and no
  // animation on the page.
  await expect(surface).toHaveCSS("transition-duration", "0s")
  expect(
    await page.evaluate(
      () => document.getAnimations().filter((a) => a.playState === "running").length,
    ),
  ).toBe(0)
  await page.getByTestId("org-fit").click()
  expect(await positionsOf(page)).toEqual(withMotion)
  expect(await faultsOf(page)).toEqual([])
  await shot(page, "org-05-reduce-motion-on")

  // Live: Cy leaves the chart within 1 second when it is archived, and the hand-off line goes.
  await rpc(page, "agents.archive", { id: cy })
  await expect(page.getByTestId("org-node")).toHaveCount(3, { timeout: 1000 })
  await expect(lines("handoff")).toHaveCount(0)
  await expect(docs.getByTestId("org-unit-members")).toHaveText("2 members")
  await shot(page, "org-06-cy-archived")

  // An organization node of 15 members draws 12 nodes and the tile "+3 more". A click on the tile lists the
  // other three. A click on a row opens the profile. The crowded chart has no overlap and no cut
  // text with "reduce motion" on and off.
  const names = Array.from({ length: 15 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`)
  const crowd: string[] = []
  for (const name of names) {
    const made = await rpc<{ id: string }>(page, "agents.create", {
      serverId: server,
      name,
      role: `${name} keeps one list`,
      instructions: "",
      model: template.model,
    })
    crowd.push(made.id)
  }
  await rpc(page, "organizations.create", {
    serverId: server,
    name: "Big",
    memberIds: crowd,
    leadId: null,
  })
  const big = orgOf(page, "Big")
  await expect(big.getByTestId("org-unit-members")).toHaveText("15 members", { timeout: 1500 })
  await expect(page.getByTestId("org-node")).toHaveCount(2 + 12 + 1)
  await expect(page.getByTestId("org-more")).toHaveText("+3 more")
  await page.getByTestId("org-fit").click()
  await page.getByTestId("org-more").click()
  await expect(page.getByTestId("org-more-list")).toBeVisible()
  await expect(page.getByTestId("org-more-row")).toHaveText([/M13/, /M14/, /M15/])
  await expect(page.getByTestId("org-more-row").first()).toBeFocused()
  await shot(page, "org-06b-more-list")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("org-more-list")).toHaveCount(0)
  await expect(page.getByTestId("org-more")).toBeFocused()
  await page.getByTestId("org-more").click()
  await page.getByTestId("org-more-row").nth(1).click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("chat-header-agent")).toContainText("M14")
  await page.keyboard.press("Escape")
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-canvas")).toBeVisible()
  for (const mode of ["off", "on"] as const) {
    await rpc(page, "settings.update", { reduceMotion: mode })
    await expect(page.locator("html")).toHaveAttribute(
      "data-reduce-motion",
      mode === "on" ? "true" : "false",
    )
    await page.getByTestId("org-fit").click()
    await settled(page)
    expect(await faultsOf(page)).toEqual([])
    await shot(page, `org-08-crowded-reduce-motion-${mode}`)
  }

  // Korean: the title, the legend, the counts and the marks are Korean; names and labels are not.
  await keepWorking(page, ada as string)
  await rpc(page, "settings.update", { language: "ko" })
  await expect(page.getByTestId("org-legend")).toContainText("이끌어요")
  await expect(page.getByTestId("org-legend")).toContainText("최근 7일간 넘긴 작업")
  await expect(page.getByTestId("org-legend")).toContainText("소속")
  await expect(adaNode.getByTestId("org-lead-mark")).toHaveText("리드")
  await expect(adaNode.getByTestId("org-state")).toContainText("작업 중")
  await expect(adaNode.getByTestId("org-task-label")).toContainText("Draft the release notes")
  await expect(page.getByTestId("org-root")).toHaveAttribute("aria-label", "나")
  await expect(orgOf(page, "Docs").getByTestId("org-unit-members")).toHaveText("멤버 2명")
  await expect(page.getByTestId("org-line-count")).toHaveCount(0)
  expect(await faultsOf(page)).toEqual([])
  await shot(page, "org-07-korean")

  // Stop the long task.
  await rpc(page, "chat.stop", { agentId: ada })
  await expect(adaNode).toHaveAttribute("data-state", "idle", { timeout: 30_000 })
  await app.close()
})

test("org chart: an organization with no member says so, and a channel does not change the chart", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 900)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    await createAgent(page, "Bo")
    const serverId = await serverOf(page)
    await page.getByTestId("page-orgchart").click()
    await expect(page.getByTestId("org-page")).toBeVisible()
    const before = await page.getByTestId("org-unit").count()

    // A channel with members makes no node and moves no node (spec 029, "Acceptance").
    await rpc(page, "channels.create", {
      serverId,
      name: "Docs",
      topic: "",
      memberIds: [await idOf(page, "Ada"), await idOf(page, "Bo")],
      leadId: null,
    })
    await expect(page.getByTestId("org-unit")).toHaveCount(before)
    await expect(orgOf(page, "Docs")).toHaveCount(0)

    // An organization with no member has a node with the line "No members.".
    await rpc(page, "organizations.create", { serverId, name: "Ops", memberIds: [], leadId: null })
    await expect(orgOf(page, "Ops")).toHaveCount(1)
    await expect(orgOf(page, "Ops").getByTestId("org-unit-empty")).toHaveText("No members.")
    await shot(page, "s127-org-chart-empty-organization")

    // In Korean the line is Korean.
    await rpc(page, "settings.update", { language: "ko" })
    await expect(orgOf(page, "Ops").getByTestId("org-unit-empty")).toHaveText("멤버가 없어요.")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})
