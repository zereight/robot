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
import { closeSettings, envFor, openDevices, report, rpc, setName } from "./sync-helpers.ts"

// Specs 001 (user sections), 012 (linked server) and 016 (knowledge). MacBook 1 (the client) opens
// MacBook 2 (the server) and may change agents and channels there. A client sees the sections of
// the server and cannot change them. It does not open the knowledge of an agent.

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const rowOf = (scope: Locator | Page, name: string) =>
  scope.locator(`[data-place-row][data-place-name="${name}"]`)
const sectionOf = (page: Page, name: string) =>
  page.getByTestId("section-agents").locator("[data-testid=user-section]", {
    has: page.getByTestId("user-section-toggle").getByText(name, { exact: true }),
  })
const plainNames = (page: Page) =>
  page
    .getByTestId("section-agents")
    .evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>("[data-place-row]")]
        .filter((row) => !row.closest("[data-testid=user-section]"))
        .map((row) => row.dataset.placeName ?? ""),
    )
const namesIn = (section: Locator) =>
  section.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("[data-place-row]")].map((row) => row.dataset.placeName),
  )
const sectionNames = (page: Page) =>
  page
    .getByTestId("section-agents")
    .getByTestId("user-section-toggle")
    .evaluateAll((all) => all.map((el) => el.textContent?.trim()))

interface Reply {
  readonly ok: boolean
  readonly code: string
}

/** A request for the linked server as the window of MacBook 1 makes it. Never throws. */
const ask = (page: Page, serverId: string, method: string, input?: unknown) =>
  page.evaluate(
    async ([m, i, s]) => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const r = await (window as any).robot.invoke(m, i, s)
      return r.ok ? { ok: true, code: "ok" } : { ok: false, code: r.error.code as string }
    },
    [method, input, serverId] as [string, unknown, string],
  ) as Promise<Reply>

const linkedServerId = (page: Page) =>
  page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
    const result = await (window as any).robot.invoke("servers.list")
    return (result.value as { id: string; kind: string }[]).find((s) => s.kind === "linked")?.id
  }) as Promise<string>

const localServerId = (page: Page) =>
  rpc<{ id: string; kind: string }[]>(page, "servers.list").then(
    (list) => list.find((s) => s.kind === "local")?.id ?? "",
  )

/** Latin words in a part of the screen. Names of devices, agents and sections are cut out first. */
const latinWords = async (page: Page, selector: string) => {
  const text = await page.locator(selector).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    for (const skip of clone.querySelectorAll("[data-user-data], pre, textarea, input, select"))
      skip.remove()
    return clone.textContent ?? ""
  })
  const words = text.replace(/MacBook|Ada|Bo|Cy|Launch|Writer|mock-fast|Mock|ROBot|VPN|sudo/g, "")
  return words.match(/[A-Za-z]{2,}/g) ?? []
}

/** Takes a row with the mouse, moves it over a header and drops it. */
const dragOnto = async (page: Page, row: Locator, target: Locator) => {
  await row.hover()
  await page.mouse.down()
  const box = await target.boundingBox()
  if (!box) throw new Error("no target")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 })
  await page.mouse.up()
}

const dismiss = async (page: Page, testId: string) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId(testId)).toBeHidden()
}

/** MacBook 2 shows a code; MacBook 1 connects one way. The switch to change agents stays on. */
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
  await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
  await closeSettings(two.page)
}

/**
 * MacBook 2 has the agents Ada and Bo, the channel Launch, the agent section Research with Ada in
 * it, and one article of Ada. MacBook 1 opens it.
 */
const start = async (
  ports: [number, number],
  section: string,
  extra: Record<string, string> = {},
) => {
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(ports[1], extra))
  const one = await launch(freshUserData(), envFor(ports[0], extra))
  await resizeWindow(two.app, 1200, 860)
  await resizeWindow(one.app, 1200, 860)
  await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
  await openDevices(two.page)
  await setName(two.page, "MacBook 2")
  await closeSettings(two.page)
  await openDevices(one.page)
  await setName(one.page, "MacBook 1")
  await closeSettings(one.page)
  await createAgent(two.page, "Ada")
  await createAgent(two.page, "Bo")
  const serverId = await localServerId(two.page)
  const agents = await rpc<{ id: string; name: string }[]>(two.page, "agents.list", {
    serverId,
    archived: false,
  })
  const ada = agents.find((a) => a.name === "Ada")?.id ?? ""
  await rpc(two.page, "channels.create", {
    serverId,
    name: "Launch",
    topic: "",
    memberIds: [ada],
    leadId: null,
  })
  const made = await rpc<{ id: string }>(two.page, "sections.create", {
    serverId,
    kind: "agent",
    name: section,
  })
  await rpc(two.page, "places.move", { kind: "agent", id: ada, sectionId: made.id })
  await rpc(two.page, "knowledge.save", {
    agentId: ada,
    file: null,
    title: "Alpha",
    summary: "The first article",
    body: "Only on MacBook 2.",
  })
  await pairOneWay(one, two)
  return { mock, one, two, serverId, ada, section: made.id }
}

test("linked sections: a client sees the sections of the server and cannot change them", async () => {
  test.setTimeout(240_000)
  const s = await start(await freePortPair(), "Research")
  const { one, two, mock } = s
  try {
    await tile(one.page, "MacBook 2").click()
    const clientServer = await linkedServerId(one.page)
    await expect(rowOf(one.page, "Ada")).toBeVisible()

    // The section and its place show as on the server. Bo is in no section.
    await expect(sectionOf(one.page, "Research")).toBeVisible()
    expect(await namesIn(sectionOf(one.page, "Research"))).toEqual(["Ada"])
    expect(await plainNames(one.page)).toEqual(["Bo"])
    expect(await sectionNames(two.page)).toEqual(["Research"])
    await shot(one.page, "s28-linked-01-client-sections")

    // Nothing of the section tools is there: the menu of Agents holds only the choice of view (spec
    // 001, "Agents by organization"), no menu on Channels, no menu on a section, no menu on a place,
    // and no box for a new section.
    await one.page.getByTestId("agents-menu").click()
    await expect(one.page.getByTestId("agents-menu-view-sections")).toBeVisible()
    await expect(one.page.getByTestId("agents-menu-view-organization")).toBeVisible()
    await expect(one.page.getByTestId("agents-menu-new-section")).toHaveCount(0)
    await expect(one.page.getByTestId("agents-menu-export")).toHaveCount(0)
    await expect(one.page.getByTestId("agents-menu-import-file")).toHaveCount(0)
    await one.page.keyboard.press("Escape")
    await expect(one.page.getByTestId("channels-menu")).toHaveCount(0)
    await expect(one.page.getByTestId("section-menu")).toHaveCount(0)
    await rowOf(one.page, "Bo").click({ button: "right" })
    await expect(one.page.getByTestId("move-to-section")).toHaveCount(0)
    await expect(one.page.getByRole("menu")).toHaveCount(0)
    await expect(one.page.getByTestId("section-new-input")).toHaveCount(0)
    // The same place on the server has them.
    await expect(two.page.getByTestId("agents-menu")).toBeVisible()
    await rowOf(two.page, "Bo").click({ button: "right" })
    await expect(two.page.getByTestId("move-to-section")).toBeVisible()
    await two.page.keyboard.press("Escape")

    // A drag of a place onto a section changes nothing here or there.
    await dragOnto(
      one.page,
      rowOf(one.page, "Bo"),
      sectionOf(one.page, "Research").getByTestId("user-section-header"),
    )
    expect(await plainNames(one.page)).toEqual(["Bo"])
    expect(await namesIn(sectionOf(two.page, "Research"))).toEqual(["Ada"])
    expect(await plainNames(two.page)).toEqual(["Bo"])

    // The forms of the client offer no section. They are the forms of the server's agents.
    await one.page.getByTestId("new-agent").click()
    await expect(one.page.getByTestId("agent-name")).toBeVisible()
    await expect(one.page.getByTestId("agent-section")).toHaveCount(0)
    await one.page.getByTestId("agent-name").fill("Cy")
    await one.page.getByTestId("model-model").waitFor()
    await shot(one.page, "s28-linked-02-new-agent-form")
    await one.page.getByTestId("agent-submit").click()
    await expect(one.page.getByTestId("chat-start").filter({ hasText: "Cy" })).toBeVisible()
    // The new agent is in no section on the server, and on the client.
    await expect(rowOf(two.page, "Cy")).toBeVisible()
    expect(await plainNames(two.page)).toEqual(["Bo", "Cy"])
    expect(await plainNames(one.page)).toEqual(["Bo", "Cy"])
    await one.page.getByTestId("new-channel").click()
    await expect(one.page.getByTestId("channel-name")).toBeVisible()
    await expect(one.page.getByTestId("channel-section")).toHaveCount(0)
    await dismiss(one.page, "channel-dialog")

    // The server moves a place and renames the section: the client follows at once.
    await rpc(two.page, "places.move", { kind: "agent", id: s.ada, sectionId: null })
    await expect(rowOf(one.page, "Ada")).toBeVisible()
    expect(await namesIn(sectionOf(one.page, "Research"))).toEqual([])
    // An empty section of the server shows a plain line, not the hint to drag a place into it.
    await expect(sectionOf(one.page, "Research").getByTestId("user-section-empty")).toHaveText(
      "No places in this section.",
    )
    const bo = (
      await rpc<{ id: string; name: string }[]>(two.page, "agents.list", {
        serverId: await localServerId(two.page),
        archived: false,
      })
    ).find((a) => a.name === "Bo")?.id
    await rpc(two.page, "places.move", { kind: "agent", id: bo, sectionId: s.section })
    await expect.poll(() => namesIn(sectionOf(one.page, "Research"))).toEqual(["Bo"])
    await rpc(two.page, "sections.rename", { id: s.section, name: "Studies" })
    await expect.poll(() => sectionNames(one.page)).toEqual(["Studies"])
    await shot(one.page, "s28-linked-03-client-follows-server")

    // A request for a section or a move from the client is refused by the server, and nothing
    // changes there.
    const refusals: Record<string, string> = {}
    for (const [method, input] of [
      ["sections.create", { serverId: clientServer, kind: "agent", name: "Sneaky" }],
      ["sections.rename", { id: s.section, name: "Hacked" }],
      ["sections.move", { id: s.section, direction: "up" }],
      ["sections.delete", { id: s.section }],
      ["places.move", { kind: "agent", id: s.ada, sectionId: s.section }],
    ] as const) {
      const reply = await ask(one.page, clientServer, method, input)
      expect(reply.ok, method).toBe(false)
      refusals[method] = reply.code
    }
    expect(await sectionNames(two.page)).toEqual(["Studies"])
    expect(await namesIn(sectionOf(two.page, "Studies"))).toEqual(["Bo"])
    expect(await plainNames(two.page)).toEqual(["Ada", "Cy"])
    // The create calls of a client must not carry a section: the strict check refuses it.
    const withSection = await ask(one.page, clientServer, "agents.create", {
      serverId: clientServer,
      name: "InSection",
      role: "",
      instructions: "",
      sectionId: s.section,
    })
    expect(withSection.code).toBe("invalid_input")
    expect(await plainNames(two.page)).toEqual(["Ada", "Cy"])
    report("s28-linked-sections", { refusals, withSection: withSection.code })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})

test("linked knowledge: a client is told where to open it, and cannot reach it", async () => {
  test.setTimeout(240_000)
  const s = await start(await freePortPair(), "Research")
  const { one, two, mock } = s
  try {
    // On the server: the Knowledge page shows the article.
    await rowOf(two.page, "Ada").click()
    await two.page.getByTestId("chat-header-agent").click()
    await two.page.getByTestId("profile-tabs").getByText("Knowledge").click()
    await expect(two.page.getByTestId("knowledge-page")).toBeVisible()
    await expect(two.page.getByTestId("knowledge-page")).toContainText("Alpha")
    await expect(two.page.getByTestId("knowledge-open-on-server")).toHaveCount(0)
    await dismiss(two.page, "agent-profile")

    // On the client: the same tab holds one muted line, the name of the server in it, and nothing
    // of the articles.
    await tile(one.page, "MacBook 2").click()
    await expect(rowOf(one.page, "Ada")).toBeVisible()
    await rowOf(one.page, "Ada").click()
    await one.page.getByTestId("chat-header-agent").click()
    await one.page.getByTestId("profile-tabs").getByText("Knowledge").click()
    await expect(one.page.getByTestId("knowledge-open-on-server")).toHaveText(
      "Open this on MacBook 2.",
    )
    await expect(one.page.getByTestId("knowledge-page")).toHaveCount(0)
    await expect(one.page.getByText("Alpha")).toHaveCount(0)
    await shot(one.page, "s28-linked-04-client-knowledge-line")
    // The form is kept: back on the profile tab, the name is still there.
    await one.page.locator("[data-testid=profile-tabs] label[data-value=profile]").click()
    await expect(one.page.getByTestId("agent-name")).toHaveValue("Ada")
    await one.page.getByTestId("profile-tabs").getByText("Knowledge").click()
    await one.page.getByTestId("knowledge-view-close").click()
    await expect(one.page.getByTestId("agent-profile")).toBeHidden()

    // The server refuses every knowledge request of the client, and nothing changes.
    const clientServer = await linkedServerId(one.page)
    const refusals: Record<string, string> = {}
    for (const [method, input] of [
      ["knowledge.list", { agentId: s.ada }],
      ["knowledge.get", { agentId: s.ada, file: "Alpha.md" }],
      [
        "knowledge.save",
        { agentId: s.ada, file: null, title: "Sneaky", summary: "s", body: "From the client." },
      ],
      ["knowledge.delete", { agentId: s.ada, file: "Alpha.md" }],
      ["knowledge.deleteSource", { agentId: s.ada, name: "x.txt" }],
      ["knowledge.openFolder", { agentId: s.ada }],
      ["knowledge.changes", { agentId: s.ada }],
      ["agentFile.export", { serverId: clientServer, agentIds: [s.ada] }],
      ["workflowFile.open", { serverId: clientServer }],
    ] as const) {
      const reply = await ask(one.page, clientServer, method, input)
      expect(reply.ok, method).toBe(false)
      refusals[method] = reply.code
    }
    const view = await rpc<{ articles: { title: string }[] }>(two.page, "knowledge.list", {
      agentId: s.ada,
    })
    expect(view.articles.map((a) => a.title)).toEqual(["Alpha"])
    report("s28-linked-knowledge", { refusals })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})

test("linked sections and knowledge: in Korean the client screens have no English left", async () => {
  test.setTimeout(240_000)
  const s = await start(await freePortPair(), "연구", { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  const { one, mock, two } = s
  try {
    await tile(one.page, "MacBook 2").click()
    await expect(rowOf(one.page, "Ada")).toBeVisible()
    await expect(sectionOf(one.page, "연구")).toBeVisible()
    expect(await latinWords(one.page, "[data-testid=place-list]")).toEqual([])
    await shot(one.page, "s28-linked-05-korean-sections")

    await one.page.getByTestId("new-agent").click()
    await expect(one.page.getByTestId("agent-name")).toBeVisible()
    await expect(one.page.getByTestId("agent-section")).toHaveCount(0)
    expect(await latinWords(one.page, "[data-testid=new-agent-dialog]")).toEqual([])
    await dismiss(one.page, "new-agent-dialog")

    await rowOf(one.page, "Ada").click()
    await one.page.getByTestId("chat-header-agent").click()
    await one.page.getByTestId("profile-tabs").getByText("지식").click()
    await expect(one.page.getByTestId("knowledge-open-on-server")).toHaveText(
      "MacBook 2에서 열어 주세요.",
    )
    expect(await latinWords(one.page, "[data-testid=agent-profile]")).toEqual([])
    await shot(one.page, "s28-linked-06-korean-knowledge-line")
    await dismiss(one.page, "agent-profile")
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
