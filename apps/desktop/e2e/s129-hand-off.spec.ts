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
import { closeSettings, envFor, openDevices, rpc, send, setName } from "./sync-helpers.ts"

// Spec 030, "Who can send to whom" and "Hand-off range", 013 (the part "Hand-off rules"), 012 (a
// linked computer), 007 ("send message" and "list agents"). The setup of the acceptance lines:
// main agent Max; the organization "Product" with lead Pia; "Docs" under "Product" with lead Dee
// and member Ann; Xan in no organization.

interface OrgInfo {
  id: string
  name: string
  handOffRange: string
}
interface TaskInfo {
  agentId: string
  source: string
  sourceId: string | null
}
interface ToolPartInfo {
  kind: string
  name?: string
  output?: string
  state?: string
}
interface MessageInfo {
  author: string
  parts: ToolPartInfo[]
}

const NAMES = ["Max", "Pia", "Dee", "Ann", "Xan"] as const

const serverIdOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const agentIdOf = async (page: Page, name: string) =>
  (
    await rpc<{ id: string; name: string }[]>(page, "agents.list", {
      serverId: await serverIdOf(page),
      archived: false,
    })
  ).find((a) => a.name === name)?.id as string
const orgsOf = async (page: Page) =>
  rpc<OrgInfo[]>(page, "organizations.list", { serverId: await serverIdOf(page) })
const orgId = async (page: Page, name: string) =>
  (await orgsOf(page)).find((o) => o.name === name)?.id as string
const makeOrg = async (
  page: Page,
  name: string,
  members: string[],
  options: { lead?: string; parent?: string; range?: string } = {},
) =>
  rpc<OrgInfo>(page, "organizations.create", {
    serverId: await serverIdOf(page),
    name,
    memberIds: await Promise.all(members.map((m) => agentIdOf(page, m))),
    leadId: options.lead ? await agentIdOf(page, options.lead) : null,
    ...(options.parent ? { parentId: await orgId(page, options.parent) } : {}),
    ...(options.range ? { handOffRange: options.range } : {}),
  })
const agentTasks = async (page: Page) =>
  (await rpc<TaskInfo[]>(page, "tasks.list", { serverId: await serverIdOf(page) })).filter(
    (t) => t.source === "agent",
  )
/** The tasks that another agent made for `name`. */
const received = async (page: Page, name: string) => {
  const id = await agentIdOf(page, name)
  return (await agentTasks(page)).filter((t) => t.agentId === id)
}
/** The output of the newest tool step in the chat of `name`. */
const lastOutput = async (page: Page, name: string) => {
  const history = await rpc<{ messages: MessageInfo[] }>(page, "chat.history", {
    agentId: await agentIdOf(page, name),
  })
  const steps = history.messages
    .filter((m) => m.author === "agent")
    .flatMap((m) => m.parts)
    .filter((p) => p.kind === "tool")
  return steps.at(-1)?.output ?? ""
}

const openChat = async (page: Page, name: string) => {
  await page.getByTestId("page-chats").click()
  await page.locator("[data-testid^=place-agent-]").filter({ hasText: name }).first().click()
  await expect(page.getByTestId("composer-input")).toBeVisible()
}
/** The agent calls the tool in its own chat. The call ends when the turn ends. */
const call = async (page: Page, name: string, tool: string, args: unknown) => {
  await openChat(page, name)
  const before = await page.getByTestId("tool-card").count()
  await send(page, `TOOL ${tool} ${JSON.stringify(args)}`)
  await expect(page.getByTestId("tool-card")).toHaveCount(before + 1, { timeout: 30_000 })
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
  return page.getByTestId("tool-card").last()
}
/** Waits until no task runs, so the next count is the final count. */
const quiet = async (page: Page) => {
  await expect
    .poll(
      async () =>
        (await rpc<{ state: string }[]>(page, "tasks.list", { serverId: await serverIdOf(page) }))
          .map((t) => t.state)
          .filter((s) => ["queued", "running", "waiting"].includes(s)).length,
      { timeout: 30_000 },
    )
    .toBe(0)
}

const startOne = async (locale = "en-US") => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: locale })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  return { mock, app, page }
}

/** The acceptance setup. The rule stays "Any agent" until a test turns it on. */
const acceptance = async (page: Page, extra: string[] = []) => {
  for (const name of [...NAMES, ...extra]) await createAgent(page, name)
  await rpc(page, "agents.update", { id: await agentIdOf(page, "Max"), patch: { isMain: true } })
  await makeOrg(page, "Product", ["Pia"], { lead: "Pia" })
  await makeOrg(page, "Docs", ["Dee", "Ann"], { lead: "Dee", parent: "Product" })
}

const openForm = async (page: Page, name: string) => {
  const close = page.getByTestId("settings-close")
  // The page may be closing already: a click on a button that goes away is not an error.
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => {})
  await expect(close).toHaveCount(0)
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-page")).toBeVisible()
  await page
    .getByTestId("org-unit")
    .filter({ has: page.getByTestId("org-unit-name").getByText(name, { exact: true }) })
    .click()
  await expect(page.getByTestId("org-dialog")).toBeVisible()
}
const saveForm = async (page: Page) => {
  await page.getByTestId("org-submit").click()
  await expect(page.getByTestId("org-dialog")).toHaveCount(0)
}
const closeForm = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("org-dialog")).toHaveCount(0)
}

test("hand-off: the field 'Hand-off range' has four values, the line 'Now', and the line for the rule 'Any agent'", async () => {
  test.setTimeout(240_000)
  const { mock, app, page } = await startOne()
  try {
    await acceptance(page)

    // The settings part is called "Hand-off rules" (013), and it offers the two rules.
    await page.getByTestId("open-settings").click()
    await expect(page.getByTestId("settings-nav-organization")).toHaveText("Hand-off rules")
    await page.getByTestId("settings-nav-organization").click()
    await expect(page.getByTestId("organization-hand-off-now")).toContainText(
      "Every agent can send a message to every other agent.",
    )
    const options = page.getByTestId("organization-hand-off").locator("label")
    await expect(options).toHaveText(["Any agent", "Along the organizations"])
    await expect(page.getByTestId("organization-ask-up-row")).toBeVisible()
    // The narrowest window: the part has no sideways scroll, and its rows stay inside the window.
    await resizeWindow(app, 480, 700)
    await page
      .getByTestId("organization-hand-off")
      .locator('label[data-value="organizations"]')
      .click()
    await expect(page.getByTestId("organization-hand-off-now")).toContainText(
      "members of its organizations",
    )
    const rowBox = (await page.getByTestId("organization-hand-off-row").boundingBox()) as {
      x: number
      width: number
    }
    expect(rowBox.x).toBeGreaterThanOrEqual(0)
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(480)
    // The control stays inside the window too: it goes under the text.
    const controlBox = (await page.getByTestId("organization-hand-off").boundingBox()) as {
      x: number
      width: number
    }
    expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(480)
    await shot(page, "s129-00-part-narrow")
    await page.getByTestId("organization-hand-off").locator('label[data-value="any"]').click()
    await resizeWindow(app, 1300, 900)

    // The form of "Docs": the range is "Inherit" at first. The rule is "Any agent", so the form
    // says that the range has no effect.
    await openForm(page, "Docs")
    const range = page.getByTestId("org-range")
    await expect(range).toHaveValue("inherit")
    await expect(range.locator("option")).toHaveText([
      "Inherit",
      "Own organization",
      "Own and lower organizations",
      "All agents",
    ])
    await expect(page.getByTestId("org-range-any")).toHaveText(
      "The hand-off rule is 'Any agent'. The range has no effect.",
    )
    // Under "Inherit" a top organization up the line gives "Own organization".
    await expect(page.getByTestId("org-range-now")).toHaveText("Now: Own organization")
    await shot(page, "s129-01-range-any-rule")
    await closeForm(page)

    // "Product" gets "Own and lower organizations". "Docs" shows what it gets from "Product".
    await openForm(page, "Product")
    await expect(page.getByTestId("org-range-now")).toHaveText("Now: Own organization")
    await range.selectOption("own_lower")
    await expect(page.getByTestId("org-range-now")).toHaveCount(0)
    await saveForm(page)
    expect((await orgsOf(page)).find((o) => o.name === "Product")?.handOffRange).toBe("own_lower")
    await openForm(page, "Docs")
    await expect(range).toHaveValue("inherit")
    await expect(page.getByTestId("org-range-now")).toHaveText(
      "Now: Own and lower organizations from Product",
    )
    // The rule "Along the organizations": the line for "Any agent" goes.
    await rpc(page, "organization.setHandOff", { rule: "organizations" })
    await expect(page.getByTestId("org-range-any")).toHaveCount(0)
    await shot(page, "s129-02-range-inherit-now")
    // The own value of "Docs" is saved, and "Inherit" back is saved too.
    await range.selectOption("all")
    await saveForm(page)
    expect((await orgsOf(page)).find((o) => o.name === "Docs")?.handOffRange).toBe("all")
    await openForm(page, "Docs")
    await expect(range).toHaveValue("all")
    await expect(page.getByTestId("org-range-now")).toHaveCount(0)
    await range.selectOption("inherit")
    await saveForm(page)
    expect((await orgsOf(page)).find((o) => o.name === "Docs")?.handOffRange).toBe("inherit")

    // The legend of the org chart names the rule only for "Along the organizations".
    await expect(page.getByTestId("org-legend-rule")).toHaveText(
      "Hand-offs follow the organizations.",
    )
    await rpc(page, "organization.setHandOff", { rule: "any" })
    await expect(page.getByTestId("org-legend-rule")).toHaveCount(0)

    // The narrowest window: the field fits, the box does not scroll sideways.
    await resizeWindow(app, 480, 600)
    await openForm(page, "Docs")
    await range.scrollIntoViewIfNeeded()
    const box = (await range.boundingBox()) as { x: number; width: number }
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(480)
    const shell = page.locator("[role=dialog]").last()
    expect(await shell.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await shot(page, "s129-03-range-narrow")
    await closeForm(page)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("hand-off: along the organizations, each send is checked with the reason, the list holds the organization, and a channel gives no right", async () => {
  test.setTimeout(300_000)
  const { mock, app, page } = await startOne()
  try {
    await acceptance(page)
    // Any agent: Ann sends to Xan, a task starts.
    const step = await call(page, "Ann", "send_message", { to: "Xan", text: "hello" })
    await expect(step).toContainText("Sent to Xan")
    await expect.poll(async () => (await received(page, "Xan")).length).toBe(1)
    await quiet(page)

    await rpc(page, "organization.setHandOff", { rule: "organizations" })
    const tasksBefore = async () => (await agentTasks(page)).length

    // Ann sends to Dee and to Max: a task starts for each.
    for (const to of ["Dee", "Max"]) {
      const before = (await received(page, to)).length
      await call(page, "Ann", "send_message", { to, text: `hi ${to}` })
      await expect.poll(async () => (await received(page, to)).length).toBe(before + 1)
      await quiet(page)
    }

    // Ann sends to Pia: the step fails with the first agent on the path. No task starts.
    const forPia = (await received(page, "Pia")).length
    const total = await tasksBefore()
    const refused = await call(page, "Ann", "send_message", { to: "Pia", text: "SECRET-TEXT" })
    await expect(refused.getByTestId("tool-reason")).toHaveText(
      "Pia is not on your path. Send it to Dee.",
    )
    await expect(refused.getByTestId("tool-reason")).toHaveAttribute("data-code", "hand_off_path")
    await expect(refused).toContainText("Failed")
    expect((await received(page, "Pia")).length).toBe(forPia)
    expect(await tasksBefore()).toBe(total)
    // The turn of Ann went on to its end.
    await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)

    // Dee sends to Pia, and Pia to Dee: the leads of a parent and of a sub-organization.
    for (const [from, to] of [
      ["Dee", "Pia"],
      ["Pia", "Dee"],
    ] as const) {
      const before = (await received(page, to)).length
      await call(page, from, "send_message", { to, text: "lead to lead" })
      await expect.poll(async () => (await received(page, to)).length).toBeGreaterThan(before)
      await quiet(page)
    }

    // Max sends to Ann (rule 3), and the reply of Ann comes back to Max.
    const forMax = (await received(page, "Max")).length
    await call(page, "Max", "send_message", { to: "Ann", text: "from the main agent" })
    await expect
      .poll(async () => (await received(page, "Max")).length, { timeout: 30_000 })
      .toBeGreaterThan(forMax)
    await quiet(page)

    // Xan, in no organization, sends to Ann: the step says to send it to Max.
    const xan = await call(page, "Xan", "send_message", { to: "Ann", text: "hi" })
    await expect(xan.getByTestId("tool-reason")).toHaveText(
      "Ann is not on your path. Send it to Max.",
    )

    // A channel with Ann and Xan gives no right: Ann still cannot send to Xan.
    const server = await serverIdOf(page)
    await rpc(page, "channels.create", {
      serverId: server,
      name: "Chat",
      topic: "",
      memberIds: [await agentIdOf(page, "Ann"), await agentIdOf(page, "Xan")],
      leadId: null,
    })
    const viaChannel = (await received(page, "Xan")).length
    const toXan = await call(page, "Ann", "send_message", { to: "Xan", text: "hi again" })
    await expect(toXan.getByTestId("tool-reason")).toHaveText(
      "Xan is not on your path. Send it to Max.",
    )
    expect((await received(page, "Xan")).length).toBe(viaChannel)

    // "List agents" of Ann holds Dee and Max only, with the organization and "main agent".
    await call(page, "Ann", "list_agents", {})
    const listed = await lastOutput(page, "Ann")
    const rows = listed.split("\n").filter((l) => l.startsWith("- "))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain("- Dee:")
    expect(rows[0]).toContain("organization: Docs")
    expect(rows[1]).toContain("- Max:")
    expect(rows[1]).toContain("main agent")
    expect(listed).toContain("The hand-off rule is on")

    // Turn off "Main agent" for Max: Xan reaches no agent.
    await rpc(page, "agents.update", { id: await agentIdOf(page, "Max"), patch: { isMain: false } })
    const none = await call(page, "Xan", "send_message", { to: "Ann", text: "hi" })
    await expect(none.getByTestId("tool-reason")).toHaveText(
      "Ann is not on your path, and no agent can pass it on. Tell the user.",
    )
    await expect(none.getByTestId("tool-reason")).toHaveAttribute("data-code", "hand_off_none")
    await shot(page, "s129-04-refused-send")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("hand-off: the range of an organization adds the right to send, down the tree and to all agents", async () => {
  test.setTimeout(300_000)
  const { mock, app, page } = await startOne()
  try {
    await acceptance(page, ["Sue"])
    await makeOrg(page, "Site", ["Sue"], { parent: "Docs" })
    await rpc(page, "organization.setHandOff", { rule: "organizations" })
    const refusedReason = async (from: string, to: string) => {
      const card = await call(page, from, "send_message", { to, text: `${from} to ${to}` })
      return card.getByTestId("tool-reason").textContent()
    }

    // Before the range: Pia cannot send to Ann.
    expect(await refusedReason("Pia", "Ann")).toContain("Ann is not on your path")

    // The range of "Product" is "Own and lower organizations", set in the form. "Docs" has
    // "Inherit".
    await openForm(page, "Product")
    await page.getByTestId("org-range").selectOption("own_lower")
    await saveForm(page)
    const forAnn = (await received(page, "Ann")).length
    await call(page, "Pia", "send_message", { to: "Ann", text: "range" })
    await expect.poll(async () => (await received(page, "Ann")).length).toBeGreaterThan(forAnn)
    await quiet(page)
    // Ann sends to a member of "Site" under "Docs": a task starts.
    const forSue = (await received(page, "Sue")).length
    await call(page, "Ann", "send_message", { to: "Sue", text: "down the tree" })
    await expect.poll(async () => (await received(page, "Sue")).length).toBeGreaterThan(forSue)
    await quiet(page)
    // Ann sends to Pia: there is no way up.
    const up = await refusedReason("Ann", "Pia")
    expect(up).toBe("Pia is not on your path. Send it to Dee.")
    // The list of Ann names "Docs", the organization that holds the range, for Sue.
    await call(page, "Ann", "list_agents", {})
    expect(
      (await lastOutput(page, "Ann")).split("\n").find((l) => l.startsWith("- Sue:")),
    ).toContain("organization: Docs")

    // The range of "Site" is "All agents": Sue sends to Xan, in no organization. Ann still cannot.
    await openForm(page, "Site")
    await page.getByTestId("org-range").selectOption("all")
    await saveForm(page)
    const forXan = (await received(page, "Xan")).length
    await call(page, "Sue", "send_message", { to: "Xan", text: "everyone" })
    await expect.poll(async () => (await received(page, "Xan")).length).toBeGreaterThan(forXan)
    await quiet(page)
    expect(await refusedReason("Ann", "Xan")).toBe("Xan is not on your path. Send it to Max.")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("hand-off: in Korean the part, the field, the values and the reasons are Korean", async () => {
  test.setTimeout(240_000)
  const { mock, app, page } = await startOne("ko-KR")
  try {
    await acceptance(page)
    await page.getByTestId("open-settings").click()
    await expect(page.getByTestId("settings-nav-organization")).toHaveText("전달 규칙")
    await page.getByTestId("settings-nav-organization").click()
    const options = page.getByTestId("organization-hand-off").locator("label")
    await expect(options).toHaveText(["아무 에이전트에게", "조직을 따라"])
    await page
      .getByTestId("organization-hand-off")
      .locator('label[data-value="organizations"]')
      .click()
    await expect(page.getByTestId("organization-hand-off-now")).toContainText("같은 조직의")
    await shot(page, "s129-05-part-korean")

    await openForm(page, "Docs")
    await expect(page.getByTestId("org-range-field")).toContainText("전달 범위")
    await expect(page.getByTestId("org-range").locator("option")).toHaveText([
      "상속",
      "자기 조직",
      "자기 조직과 하위 조직",
      "모든 에이전트",
    ])
    await expect(page.getByTestId("org-range-now")).toHaveText("지금: 자기 조직")
    await page.getByTestId("org-range").selectOption("own_lower")
    await saveForm(page)
    await openForm(page, "Docs")
    await shot(page, "s129-06-range-korean")
    await closeForm(page)
    // The rule "Any agent": the muted line is Korean.
    await rpc(page, "organization.setHandOff", { rule: "any" })
    await openForm(page, "Docs")
    await expect(page.getByTestId("org-range-any")).toHaveText(
      "전달 규칙이 ‘아무 에이전트에게’예요. 전달 범위는 효과가 없어요.",
    )
    await closeForm(page)
    await rpc(page, "organization.setHandOff", { rule: "organizations" })

    // Docs has the range now ("Own and lower organizations"); Xan is in no organization.
    const refused = await call(page, "Xan", "send_message", { to: "Ann", text: "hi" })
    await expect(refused.getByTestId("tool-reason")).toHaveText(
      "Ann은 보낼 수 있는 경로에 없어요. Max에게 보내세요.",
    )
    await expect(page.getByTestId("org-legend-rule")).toHaveCount(0)
    await page.getByTestId("page-orgchart").click()
    await expect(page.getByTestId("org-legend-rule")).toHaveText("전달은 조직을 따라가요.")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// --- A linked computer (spec 012) --------------------------------------------------------------

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const linkedServerId = (page: Page) =>
  page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
    const result = await (window as any).robot.invoke("servers.list")
    return (result.value as { id: string; kind: string }[]).find((s) => s.kind === "linked")?.id
  }) as Promise<string>
const ask = (page: Page, serverId: string, method: string, input?: unknown) =>
  page.evaluate(
    async ([m, i, s]) => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const r = await (window as any).robot.invoke(m, i, s)
      return r.ok ? "ok" : (r.error.code as string)
    },
    [method, input, serverId] as [string, unknown, string],
  )

/** MacBook 2 shows a code; MacBook 1 connects one way. `canChange` is the switch of the dialog. */
const pairOneWay = async (one: Launched, two: Launched, canChange: boolean) => {
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
  await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
  if (!canChange) await two.page.getByTestId("join-can-change").click()
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

const startPair = async () => {
  const ports = await freePortPair()
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(ports[1]))
  const one = await launch(freshUserData(), envFor(ports[0]))
  await resizeWindow(two.app, 1200, 860)
  await resizeWindow(one.app, 1200, 860)
  await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
  await openDevices(two.page)
  await setName(two.page, "MacBook 2")
  await closeSettings(two.page)
  await openDevices(one.page)
  await setName(one.page, "MacBook 1")
  await closeSettings(one.page)
  return { mock, one, two }
}

for (const canChange of [true, false]) {
  test(`hand-off on a linked computer ${canChange ? "with" : "without"} the switch: the part is read only, and the range ${canChange ? "is saved on the server" : "is read only and the server refuses a change"}`, async () => {
    test.setTimeout(300_000)
    const { mock, one, two } = await startPair()
    try {
      await createAgent(two.page, "Ada")
      await createAgent(two.page, "Bo")
      await makeOrg(two.page, "Product", ["Ada"], { lead: "Ada" })
      await rpc(two.page, "organization.setHandOff", { rule: "organizations" })
      await pairOneWay(one, two, canChange)
      await closeSettings(two.page)
      await tile(one.page, "MacBook 2").click()

      // The part "Hand-off rules" shows the rule of the server and changes nothing (012).
      await one.page.getByTestId("open-settings").click()
      await one.page.getByTestId("settings-nav-organization").click()
      await expect(one.page.getByTestId("organization-remote")).toContainText("Hand-off rules")
      await expect(one.page.getByTestId("organization-hand-off-now")).toContainText(
        "members of its organizations",
      )
      const radios = one.page.getByTestId("organization-hand-off").locator("input")
      for (let i = 0; i < (await radios.count()); i++) await expect(radios.nth(i)).toBeDisabled()
      await expect(one.page.getByTestId("organization-ask-up")).toBeDisabled()
      await expect(one.page.getByTestId("organization-readonly")).toContainText("MacBook 2")
      const serverId = await linkedServerId(one.page)
      expect(await ask(one.page, serverId, "organization.setHandOff", { rule: "any" })).toBe(
        "not_allowed",
      )
      await closeSettings(one.page)

      // The form of the organization shows the range of the server.
      await openForm(one.page, "Product")
      const range = one.page.getByTestId("org-range")
      await expect(range).toHaveValue("inherit")
      await expect(one.page.getByTestId("org-range-any")).toHaveCount(0)
      const id = await orgId(two.page, "Product")
      if (canChange) {
        await expect(range).toBeEnabled()
        await range.selectOption("all")
        await saveForm(one.page)
        await expect
          .poll(
            async () => (await orgsOf(two.page)).find((o) => o.name === "Product")?.handOffRange,
          )
          .toBe("all")
      } else {
        await expect(range).toBeDisabled()
        await shot(one.page, "s129-07-linked-range-read-only")
        await closeForm(one.page)
        expect(
          await ask(one.page, serverId, "organizations.update", {
            id,
            patch: { handOffRange: "all" },
          }),
        ).toBe("change_off")
        expect((await orgsOf(two.page)).find((o) => o.name === "Product")?.handOffRange).toBe(
          "inherit",
        )
      }
    } finally {
      await one.app.close().catch(() => {})
      await two.app.close().catch(() => {})
      await mock.close()
    }
  })
}
