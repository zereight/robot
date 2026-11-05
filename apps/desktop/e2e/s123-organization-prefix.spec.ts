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

// Spec 035: the organization prefix "[Docs] Ada". The prefix comes from the deepest organization of
// an agent. It shows in the places of the window, it follows the organizations at once, and the
// stored name does not change. One test runs on one computer in English, one in Korean with the
// narrowest window, and one on a linked computer that has its own switch (012).

interface OrgInfo {
  id: string
  name: string
  parentId: string | null
  memberIds: string[]
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
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await localServerId(page), archived: false })
const agentId = async (page: Page, name: string) =>
  (await agentsOf(page)).find((a) => a.name === name)?.id as string
const orgByName = async (page: Page, name: string) =>
  (await rpc<OrgInfo[]>(page, "organizations.list", { serverId: await localServerId(page) })).find(
    (o) => o.name === name,
  ) as OrgInfo
const makeOrg = async (page: Page, name: string, members: string[], parent?: string) =>
  rpc<OrgInfo>(page, "organizations.create", {
    serverId: await localServerId(page),
    name,
    memberIds: await Promise.all(members.map((m) => agentId(page, m))),
    leadId: null,
    ...(parent ? { parentId: (await orgByName(page, parent)).id } : {}),
  })
const setMembers = async (page: Page, org: string, members: string[]) =>
  rpc(page, "organizations.update", {
    id: (await orgByName(page, org)).id,
    patch: { memberIds: await Promise.all(members.map((m) => agentId(page, m))) },
  })
const makeAgent = async (page: Page, name: string, role = "") => {
  const template = (await agentsOf(page))[0] as AgentInfo
  return rpc<AgentInfo>(page, "agents.create", {
    serverId: await localServerId(page),
    name,
    role,
    instructions: "",
    model: template.model,
  })
}

const row = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`)
const prefixOf = (page: Page, name: string) => row(page, name).getByTestId("org-prefix")
const rowNames = (page: Page) =>
  page
    .locator("[data-place-row]")
    .evaluateAll((all) => all.map((el) => (el as HTMLElement).dataset.placeName ?? ""))

/** Turns the switch of this computer to a state, in Settings → Appearance. */
const setSwitch = async (page: Page, on: boolean) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  const toggle = page.getByTestId("setting-show-org-prefix")
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute("aria-checked", String(on))
  await page.getByTestId("settings-close").click()
}

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const CHAT = "/v1/chat/completions"

test("organization prefix: row, switch and restart, membership, rename, long name, mention, search, tools, chart, archive", async () => {
  test.setTimeout(360_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const ada = (await agentsOf(page))[0] as AgentInfo
  await rpc(page, "agents.update", { id: ada.id, patch: { role: "Designer" } })
  await makeAgent(page, "Bo")
  await makeAgent(page, "Cy")

  // "Docs" with Ada: the row shows "[Docs] Ada" and the role badge after the name. Bo is in no
  // organization and shows no prefix. The form of the agent holds the stored name.
  await makeOrg(page, "Docs", ["Ada"])
  await expect(prefixOf(page, "Ada")).toHaveText("[Docs]")
  await expect(row(page, "Ada")).toContainText("[Docs] Ada")
  await expect(row(page, "Ada").getByTestId("role-badge")).toHaveText("Designer")
  const badgeAfterName = await row(page, "Ada").evaluate((el) => {
    const prefix = el.querySelector("[data-testid=org-prefix]")
    const badge = el.querySelector("[data-testid=role-badge]")
    return !!prefix && !!badge && !!(prefix.compareDocumentPosition(badge) & 4)
  })
  expect(badgeAfterName).toBe(true)
  await expect(prefixOf(page, "Bo")).toHaveCount(0)
  await expect(row(page, "Bo")).toContainText("Bo")
  await row(page, "Ada").click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("[Docs] Ada")
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-name")).toHaveValue("Ada")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await shot(page, "s123-01-row-and-header")

  // The note on the prefix shows the whole name of the organization (a title). The row names the
  // organization for a screen reader.
  await expect(prefixOf(page, "Ada")).toHaveAttribute("title", "Docs")
  await expect(row(page, "Ada")).toHaveAccessibleName(/^Ada, Docs, /)

  // The switch: off, every prefix goes; on, it is back; a restart keeps the state.
  await setSwitch(page, false)
  await expect(prefixOf(page, "Ada")).toHaveCount(0)
  await expect(page.getByTestId("chat-header-agent")).not.toContainText("[Docs]")
  await shot(page, "s123-02-switch-off")
  await setSwitch(page, true)
  await expect(prefixOf(page, "Ada")).toHaveText("[Docs]")
  await setSwitch(page, false)
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1300, 900)
  await expect(row(page, "Ada")).toBeVisible()
  await expect(prefixOf(page, "Ada")).toHaveCount(0)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await expect(page.getByTestId("setting-show-org-prefix")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-close").click()
  await setSwitch(page, true)
  await expect(prefixOf(page, "Ada")).toHaveText("[Docs]")

  // Membership: Ada in "Docs" under "Product" and in "Product" shows "[Docs]". Leave "Docs": the
  // prefix is "[Product]". Leave "Product": none.
  await makeOrg(page, "Product", [])
  await rpc(page, "organizations.update", {
    id: (await orgByName(page, "Docs")).id,
    patch: { parentId: (await orgByName(page, "Product")).id },
  })
  await setMembers(page, "Product", ["Ada"])
  await expect(prefixOf(page, "Ada")).toHaveText("[Docs]")
  await setMembers(page, "Docs", [])
  await expect(prefixOf(page, "Ada")).toHaveText("[Product]")
  await setMembers(page, "Product", [])
  await expect(prefixOf(page, "Ada")).toHaveCount(0)
  await setMembers(page, "Docs", ["Ada"])
  await expect(prefixOf(page, "Ada")).toHaveText("[Docs]")

  // A message of Ada, then a rename of "Docs" while the conversation is open: the header, the
  // header line of the old message and the row change within 1 second. No request goes to the
  // model, and no task starts, for the rename.
  await send(page, "hello")
  await expect(page.getByTestId("message").filter({ hasText: "You said: hello" })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
  const agentMessage = page.locator("[data-testid=message][data-author=agent]").first()
  await expect(agentMessage.getByTestId("message-name")).toContainText("[Docs] Ada")
  const requests = mock.requests.filter((r) => r.path === CHAT).length
  const tasks = (await rpc<unknown[]>(page, "tasks.list", { serverId: await localServerId(page) }))
    .length
  await rpc(page, "organizations.update", {
    id: (await orgByName(page, "Docs")).id,
    patch: { name: "Documentation" },
  })
  await expect(prefixOf(page, "Ada")).toHaveText("[Documentation]", { timeout: 1500 })
  await expect(page.getByTestId("chat-header-agent")).toContainText("[Documentation] Ada", {
    timeout: 1500,
  })
  await expect(agentMessage.getByTestId("message-name")).toContainText("[Documentation] Ada", {
    timeout: 1500,
  })
  await shot(page, "s123-03-renamed")
  expect(mock.requests.filter((r) => r.path === CHAT).length).toBe(requests)
  expect(
    (await rpc<unknown[]>(page, "tasks.list", { serverId: await localServerId(page) })).length,
  ).toBe(tasks)
  await rpc(page, "organizations.update", {
    id: (await orgByName(page, "Documentation")).id,
    patch: { name: "Docs" },
  })
  await expect(prefixOf(page, "Ada")).toHaveText("[Docs]")

  // A long name: the prefix is cut at 16 characters, the note holds the whole name, and a screen
  // reader reads "Ada, Research and Development Group".
  await rpc(page, "organizations.update", {
    id: (await orgByName(page, "Docs")).id,
    patch: { name: "Research and Development Group" },
  })
  await expect(prefixOf(page, "Ada")).toHaveText("[Research and Dev…]")
  await expect(prefixOf(page, "Ada")).toHaveAttribute("title", "Research and Development Group")
  await expect(row(page, "Ada")).toHaveAccessibleName(/^Ada, Research and Development Group, /)
  await expect(agentMessage.locator("[data-org-name]").first()).toHaveAttribute(
    "aria-label",
    "Ada, Research and Development Group",
  )
  await shot(page, "s123-04-long-name")
  await rpc(page, "organizations.update", {
    id: (await orgByName(page, "Research and Development Group")).id,
    patch: { name: "Docs" },
  })
  await expect(prefixOf(page, "Ada")).toHaveText("[Docs]")

  // The search of places matches the whole organization name, and the order does not change.
  const before = await rowNames(page)
  const search = page.getByTestId("place-search")
  await search.fill("docs")
  await expect(row(page, "Ada")).toBeVisible()
  await expect(row(page, "Bo")).toHaveCount(0)
  await expect(row(page, "Cy")).toHaveCount(0)
  await search.fill("")
  expect(await rowNames(page)).toEqual(before)
  // With the switch off the organization does not match.
  await setSwitch(page, false)
  await search.fill("docs")
  await expect(row(page, "Ada")).toHaveCount(0)
  await search.fill("")
  await setSwitch(page, true)

  // A channel: "@doc" lists "[Docs] Ada"; a pick writes "@Ada"; the sent message holds "@Ada".
  await rpc(page, "channels.create", {
    serverId: await localServerId(page),
    name: "Launch",
    topic: "",
    memberIds: [ada.id, await agentId(page, "Bo")],
    leadId: ada.id,
  })
  await page.locator("[data-testid^=place-channel-]").filter({ hasText: "Launch" }).click()
  const input = page.getByTestId("channel-input")
  const options = page.getByTestId("mention-option")
  await input.click()
  await input.pressSequentially("@doc")
  await expect(options).toHaveCount(1)
  await expect(options.first()).toContainText("[Docs] Ada")
  await expect(options.first()).toHaveAttribute("data-member", "Ada")
  await shot(page, "s123-05-mention")
  await input.press("Enter")
  await expect(input).toHaveValue("@Ada ")
  await input.fill("")
  // The switch off: "@doc" shows no agent, and "@a" still lists Ada by name, with no prefix.
  await setSwitch(page, false)
  await input.click()
  await input.pressSequentially("@doc")
  await expect(page.getByTestId("mention-list")).toHaveCount(0)
  await input.fill("")
  await input.pressSequentially("@a")
  await expect(options.first()).toContainText("@Ada")
  await input.fill("")
  await setSwitch(page, true)
  await input.click()
  await input.pressSequentially("@doc")
  await options.first().click()
  await input.pressSequentially("please check")
  await input.press("Enter")
  await expect(
    page.getByTestId("channel-message").filter({ hasText: "@Ada please check" }).first(),
  ).toBeVisible({ timeout: 30_000 })

  // "list agents" gives the stored names with no prefix, and "send message" to "Bo" works.
  await row(page, "Ada").click()
  await send(page, "TOOL list_agents {}")
  await expect
    .poll(
      () =>
        mock.requests
          .filter((r) => r.path === CHAT)
          .some((r) => JSON.stringify(r.body).includes("- Bo:")),
      { timeout: 30_000 },
    )
    .toBe(true)
  const listed = mock.requests
    .filter((r) => r.path === CHAT)
    .map((r) => JSON.stringify(r.body))
    .filter((body) => body.includes("- Bo:"))
  expect(listed.length).toBeGreaterThan(0)
  for (const body of listed) {
    expect(body).toContain("- Bo:")
    expect(body).not.toContain("[Docs]")
  }
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
  await send(page, 'TOOL send_message {"to":"Bo","text":"Please check the facts"}')
  await expect
    .poll(
      async () =>
        (
          await rpc<{ source: string }[]>(page, "tasks.list", {
            serverId: await localServerId(page),
          })
        ).filter((t) => t.source === "agent").length,
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(1)

  // The org chart shows "Ada" with no prefix, in the node of "Docs".
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-page")).toBeVisible()
  const docsNode = page.getByTestId("org-unit").filter({ hasText: "Docs" })
  const adaNode = page
    .getByTestId("org-node")
    .filter({ has: page.getByTestId("org-name").getByText("Ada", { exact: true }) })
  await expect(adaNode).toBeVisible()
  await expect(adaNode.getByTestId("org-name")).toHaveText("Ada")
  // The node of "Docs" counts Ada as a member; its node is drawn by the chart (029).
  await expect(docsNode.getByTestId("org-unit-members")).toHaveText("1 member")
  await expect(page.getByTestId("org-page").getByTestId("org-prefix")).toHaveCount(0)
  await expect(page.getByTestId("org-page")).not.toContainText("[Docs]")
  await shot(page, "s123-06-org-chart")
  await page.getByTestId("page-chats").click()

  // The archive list shows the prefix too.
  await rpc(page, "agents.archive", { id: ada.id })
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await expect(page.getByTestId(`archived-${ada.id}`)).toContainText("[Docs] Ada")
  await shot(page, "s123-07-archive")
  await app.close()
  await mock.close()
})

test("organization prefix: Korean words, the narrowest window, and a cut name next to the role badge", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const ada = (await agentsOf(page))[0] as AgentInfo
  await rpc(page, "agents.update", {
    id: ada.id,
    patch: { role: "Writes the first draft of every article" },
  })
  await makeAgent(page, "Bo", "Keeps the calendar and the plan of the whole team")
  await makeOrg(page, "Research and Development Group", ["Ada"])
  await makeOrg(page, "문서팀", ["Bo"])

  // The switch and its note are Korean; the organization names keep their own text.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  const toggle = page.getByTestId("setting-show-org-prefix")
  await expect(toggle).toHaveAttribute("aria-label", "에이전트 이름 앞에 조직 표시")
  await expect(toggle).toHaveAttribute("aria-checked", "true")
  await shot(page, "s123-ko-01-switch")
  await page.getByTestId("settings-close").click()
  await expect(prefixOf(page, "Ada")).toHaveText("[Research and Dev…]")
  await expect(prefixOf(page, "Bo")).toHaveText("[문서팀]")
  await expect(row(page, "Ada")).toHaveAccessibleName(/^Ada, Research and Development Group, /)
  await expect(row(page, "Bo")).toHaveAccessibleName(/^Bo, 문서팀, /)
  await shot(page, "s123-ko-02-rows")

  // The narrowest window: the role badge hides first, then the name is cut, and the prefix stays.
  await resizeWindow(app, 480, 400)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(500)
  await expect(prefixOf(page, "Ada")).toBeVisible()
  await expect(prefixOf(page, "Ada")).toHaveText("[Research and Dev…]")
  await shot(page, "s123-ko-03-narrow")
  await resizeWindow(app, 1300, 900)

  // Compact list, and the switch off at the narrowest window.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-compact-places").click()
  await page.getByTestId("setting-show-org-prefix").click()
  await page.getByTestId("settings-close").click()
  await expect(prefixOf(page, "Ada")).toHaveCount(0)
  await resizeWindow(app, 480, 400)
  await shot(page, "s123-ko-04-narrow-off")
  await app.close()
  await mock.close()
})

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)

/** MacBook 2 shows a code; MacBook 1 connects one way (the link is enough to read). */
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
  await one.page.getByTestId("connect-two-way").click()
  await one.page.getByTestId("connect-finish").click()
  await two.page.getByTestId("join-can-change").click() // on at first: turn it off
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

test("organization prefix: a linked computer shows the prefixes of the server with its own switch", async () => {
  test.setTimeout(300_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const mock = await startMockProvider()
  const two: Launched = await launch(freshUserData(), envFor(PORT_2))
  const one: Launched = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(two.app, 1300, 860)
    await resizeWindow(one.app, 1300, 860)
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(two.page, "Ada")
    await makeAgent(two.page, "Bo")
    await makeOrg(two.page, "Docs", ["Ada"])
    // MacBook 1 has its own agent "Zed" in its own organization "Local".
    await rpc(one.page, "agents.create", {
      serverId: await localServerId(one.page),
      name: "Zed",
      role: "",
      instructions: "",
    })
    await makeOrg(one.page, "Local", ["Zed"])
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)
    await pairOneWay(one, two)
    await closeSettings(two.page)

    // The places of MacBook 2 on MacBook 1: "[Docs] Ada", and none for Bo. The own places of
    // MacBook 1 keep their own organization.
    await expect(prefixOf(one.page, "Zed")).toHaveText("[Local]")
    await tile(one.page, "MacBook 2").click()
    await expect(row(one.page, "Ada")).toBeVisible()
    await expect(prefixOf(one.page, "Ada")).toHaveText("[Docs]")
    await expect(prefixOf(one.page, "Bo")).toHaveCount(0)
    await shot(one.page, "s123-linked-01-prefix")

    // A rename on MacBook 2 reaches MacBook 1.
    await rpc(two.page, "organizations.update", {
      id: (await orgByName(two.page, "Docs")).id,
      patch: { name: "Articles" },
    })
    await expect(prefixOf(one.page, "Ada")).toHaveText("[Articles]", { timeout: 5000 })

    // The switch of MacBook 1 decides on MacBook 1; MacBook 2 keeps its own.
    await setSwitch(one.page, false)
    await expect(prefixOf(one.page, "Ada")).toHaveCount(0)
    await expect(row(one.page, "Ada")).toContainText("Ada")
    await shot(one.page, "s123-linked-02-switch-off")
    await expect(prefixOf(two.page, "Ada")).toHaveText("[Articles]")
    await setSwitch(one.page, true)
    await expect(prefixOf(one.page, "Ada")).toHaveText("[Articles]")
  } finally {
    await one.app.close()
    await two.app.close()
    await mock.close()
  }
})
