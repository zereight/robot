import { expect, type Locator, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  type Launched,
  launch,
  pickRole,
  resizeWindow,
  shot,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import { closeSettings, envFor, openDevices, rpc, setName } from "./sync-helpers.ts"

// Slice S107: the role label (spec 002), the role badge and the filter of places by role line
// (001), and the roles list that the field shares with the Roles page (013). A copy of the app
// runs on its own data folder with the stand-in provider.

const row = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`)
const badge = (page: Page, name: string) => row(page, name).getByTestId("role-badge")
const search = (page: Page) => page.getByTestId("place-search")
const rowNames = (page: Page) =>
  page
    .locator("[data-place-row]")
    .evaluateAll((all) => all.map((el) => (el as HTMLElement).dataset.placeName ?? ""))

interface Created {
  readonly id: string
}

/** Makes places straight through the host, as a quick set-up. The window shows them at once. */
const seed = async (page: Page) => {
  const servers = await rpc<{ id: string; kind: string }[]>(page, "servers.list")
  const serverId = servers.find((s) => s.kind === "local")?.id ?? ""
  const agent = (name: string, role: string) =>
    rpc<Created>(page, "agents.create", { serverId, name, role, instructions: "Be brief." })
  return { serverId, agent }
}

/** The options of the open role list: the role, and the number of agents that have it. */
const optionsOf = (page: Page) =>
  page.getByTestId("agent-role-option").evaluateAll((all) =>
    all.map((el) => ({
      role: el.querySelector("[data-user-data]")?.textContent ?? "",
      count: Number(el.querySelector("[data-testid=agent-role-count]")?.textContent ?? "0"),
    })),
  )

const openList = async (page: Page) => {
  await page.getByTestId("agent-role-open").or(page.getByTestId("agent-role-chip")).click()
  await expect(page.getByTestId("agent-role-list")).toBeVisible()
  // The text box has the focus when the list opens.
  await expect(page.getByTestId("agent-role-filter")).toBeFocused()
}
const filterBox = (page: Page) => page.getByTestId("agent-role-filter")
const chip = (page: Page) => page.getByTestId("agent-role-chip")

const openProfile = async (page: Page, name: string) => {
  await row(page, name).click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}

/**
 * A shot at the smallest window that the app allows (480 by 400 px), with the part under test in
 * view. The window goes back to its size after the shot.
 */
const smallShot = async (
  app: Launched["app"],
  page: Page,
  name: string,
  focus?: Locator,
  check?: () => Promise<void>,
) => {
  await resizeWindow(app, 480, 400)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(500)
  await focus?.scrollIntoViewIfNeeded()
  await check?.()
  await shot(page, name)
  await resizeWindow(app, 1100, 800)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1000)
}

test("role label: pick, add, remove, keys, limit, starter, duplicate (spec 002, 013)", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)

  // Two agents have "Designer" in two spellings, one has "Writer", one has "Researcher". An archived
  // agent has "Archivist": its role is not in the list.
  const made = await seed(page)
  const ada = await made.agent("Ada", "Designer")
  await made.agent("Bo", "designer")
  const cy = await made.agent("Cy", "Writer")
  await made.agent("Dee", "Researcher")
  const eli = await made.agent("Eli", "Archivist")
  await rpc(page, "agents.archive", { id: eli.id })
  await expect(row(page, "Ada")).toBeVisible()
  await expect(row(page, "Eli")).toHaveCount(0)

  // A new agent has no role: the field shows the muted button, and the list holds the roles of the
  // other agents in alphabetical order, with the number of agents of each. A role of an archived
  // agent is not in it. The list has its text box focused, and the mark is on the first choice.
  await page.getByTestId("new-agent").click()
  await expect(page.getByTestId("agent-role-chip")).toHaveCount(0)
  await expect(page.getByTestId("agent-role-open")).toHaveText("Choose a role")
  await shot(page, "s107-01-en-empty")
  await openList(page)
  expect(await optionsOf(page)).toEqual([
    { role: "Designer", count: 2 },
    { role: "Researcher", count: 1 },
    { role: "Writer", count: 1 },
  ])
  await expect(page.getByTestId("agent-role-add")).toHaveCount(0)
  await expect(page.getByTestId("agent-role-option").first()).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await shot(page, "s107-02-en-list")

  // The keys: Down and Up move the mark and go round. Escape closes the list and nothing changes;
  // the form stays open.
  await filterBox(page).press("ArrowDown")
  await expect(page.getByTestId("agent-role-option").nth(1)).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await filterBox(page).press("ArrowUp")
  await filterBox(page).press("ArrowUp")
  await expect(page.getByTestId("agent-role-option").nth(2)).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await filterBox(page).press("Escape")
  await expect(page.getByTestId("agent-role-list")).toBeHidden()
  await expect(page.getByTestId("new-agent-dialog")).toBeVisible()
  await expect(page.getByTestId("agent-role-open")).toBeFocused()
  await expect(page.getByTestId("agent-role-chip")).toHaveCount(0)

  // Typed text keeps the roles that hold it, ignoring case. A text that no role equals adds the
  // last choice "Add <text>". Enter picks it, and the field shows a chip.
  await openList(page)
  await filterBox(page).fill("RES")
  expect(await optionsOf(page)).toEqual([{ role: "Researcher", count: 1 }])
  await expect(page.getByTestId("agent-role-add")).toHaveText("Add RES")
  await filterBox(page).fill("Qa tester")
  expect(await optionsOf(page)).toEqual([])
  await expect(page.getByTestId("agent-role-add")).toHaveText("Add Qa tester")
  await expect(page.getByTestId("agent-role-add")).toHaveAttribute("aria-selected", "true")
  await shot(page, "s107-03-en-add")
  await smallShot(app, page, "s107-03-en-add-small", page.getByTestId("agent-role-list"))
  await filterBox(page).press("Enter")
  await expect(page.getByTestId("agent-role-list")).toBeHidden()
  // Enter did not send the form.
  await expect(page.getByTestId("new-agent-dialog")).toBeVisible()
  await expect(chip(page)).toHaveText("Qa tester")
  await expect(chip(page)).toBeFocused()
  await page.getByTestId("agent-name").fill("Quinn")
  await page.getByTestId("model-model").waitFor()
  await shot(page, "s107-04-en-chip")
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
  await expect(badge(page, "Quinn")).toHaveText("Qa tester")
  await openProfile(page, "Quinn")
  await expect(chip(page)).toHaveText("Qa tester")

  // A text that equals a listed role, ignoring case, gets the spelling of the list: no "Add", and
  // Enter picks "Designer" even though "designer" is a second spelling. The mark is on the equal
  // role also when another role stands first.
  await openList(page)
  expect(await optionsOf(page)).toEqual([
    { role: "Designer", count: 2 },
    { role: "Qa tester", count: 1 },
    { role: "Researcher", count: 1 },
    { role: "Writer", count: 1 },
  ])
  await expect(page.getByTestId("agent-role-option").nth(1)).toHaveAttribute("aria-current", "true")
  await filterBox(page).fill("designer")
  await expect(page.getByTestId("agent-role-add")).toHaveCount(0)
  await filterBox(page).press("Enter")
  await expect(chip(page)).toHaveText("Designer")

  // 121 characters: "Add" is off, with a reason. Escape closes the list and the role stays.
  await openList(page)
  await filterBox(page).fill("x".repeat(121))
  await expect(page.getByTestId("agent-role-add")).toHaveAttribute("aria-disabled", "true")
  await expect(page.getByTestId("agent-role-toolong")).toHaveText(
    "The role can have at most 120 characters.",
  )
  await filterBox(page).press("Enter")
  await expect(page.getByTestId("agent-role-list")).toBeVisible()
  await shot(page, "s107-05-en-toolong")
  await smallShot(app, page, "s107-05-en-toolong-small", page.getByTestId("agent-role-list"))
  await filterBox(page).press("Escape")
  await expect(page.getByTestId("agent-role-list")).toBeHidden()
  await expect(chip(page)).toHaveText("Designer")
  // 120 characters fit.
  await openList(page)
  await filterBox(page).fill("y".repeat(120))
  await expect(page.getByTestId("agent-role-add")).not.toHaveAttribute("aria-disabled", "true")
  await expect(page.getByTestId("agent-role-toolong")).toHaveCount(0)
  await filterBox(page).press("Escape")

  // The agent changes when the user saves, not before. Quinn still has "Qa tester".
  expect((await rpc<{ role: string }>(page, "agents.get", { id: ada.id })).role).toBe("Designer")
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("agent-profile").waitFor({ state: "detached" })
  await expect(badge(page, "Quinn")).toHaveText("Designer")

  // Remove empties the role of this agent only. It changes after Save. Another agent keeps it.
  await openProfile(page, "Quinn")
  await page.getByTestId("agent-role-remove").click()
  await expect(chip(page)).toHaveCount(0)
  await expect(page.getByTestId("agent-role-open")).toBeFocused()
  await expect(badge(page, "Quinn")).toHaveText("Designer")
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("agent-profile").waitFor({ state: "detached" })
  await expect(badge(page, "Quinn")).toHaveCount(0)
  await expect(badge(page, "Ada")).toHaveText("Designer")

  // A role that no agent has leaves the list: Cy was the only "Writer".
  await openProfile(page, "Cy")
  await expect(chip(page)).toHaveText("Writer")
  await page.getByTestId("agent-role-remove").click()
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("agent-profile").waitFor({ state: "detached" })
  expect((await rpc<{ role: string }>(page, "agents.get", { id: cy.id })).role).toBe("")
  await page.getByTestId("new-agent").click()
  await openList(page)
  expect((await optionsOf(page)).map((o) => o.role)).toEqual(["Designer", "Researcher"])

  // A starter fills the field, and it shows as a chip.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-role-list")).toBeHidden()
  await page.getByTestId("starter-reviewer").click()
  await expect(chip(page)).toHaveText("Reads code changes and reports problems.")

  // A long role is cut with an ellipsis in the chip, at the smallest window, and the whole text
  // shows in the note. The chip never grows past the form.
  const long = `${"A long role line that needs more room than the chip has. ".repeat(2)}End`
  await pickRole(page, long)
  await expect(chip(page)).toHaveText(long)
  await expect(chip(page)).toHaveAttribute("title", long)
  await smallShot(app, page, "s107-06-en-long-small", chip(page), async () => {
    const cut = await chip(page)
      .locator("span")
      .evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(cut).toBe(true)
    const [form, box] = await Promise.all([
      page.getByTestId("agent-form").boundingBox(),
      chip(page).boundingBox(),
    ])
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      (form?.x ?? 0) + (form?.width ?? 0),
    )
  })
  await page.getByTestId("agent-form").getByRole("button", { name: "Cancel" }).click()
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })

  // Duplicate: the copy has the same role line, and a badge.
  await openProfile(page, "Ada")
  await page.getByTestId("agent-duplicate").click()
  await expect(row(page, "Ada copy")).toBeVisible()
  await expect(badge(page, "Ada copy")).toHaveText("Designer")
  await page.keyboard.press("Escape").catch(() => undefined)

  // Korean: the same field with the texts of the catalogue.
  await app.close()
  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
  await resizeWindow(app, 1100, 800)
  await page.getByTestId("new-agent").click()
  await expect(page.getByTestId("agent-role-open")).toHaveText("역할 고르기")
  await shot(page, "s107-01-ko-empty")
  await openList(page)
  await shot(page, "s107-02-ko-list")
  await filterBox(page).fill("테스트 담당")
  await expect(page.getByTestId("agent-role-add")).toHaveText("테스트 담당 추가")
  await shot(page, "s107-03-ko-add")
  await smallShot(app, page, "s107-03-ko-add-small", page.getByTestId("agent-role-list"))
  await filterBox(page).fill("가".repeat(121))
  await expect(page.getByTestId("agent-role-toolong")).toHaveText("역할은 120자까지 쓸 수 있어요.")
  await shot(page, "s107-05-ko-toolong")
  await smallShot(app, page, "s107-05-ko-toolong-small", page.getByTestId("agent-role-list"))
  await filterBox(page).press("Escape")
  await filterBox(page).waitFor({ state: "detached" })
  await app.close()
  await mock.close()
})

test("role badge and the filter of places by role line (spec 001)", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)

  const made = await seed(page)
  const ada = await made.agent("Ada", "Designer")
  await made.agent("Bo", "Writer")
  await made.agent("Cy", "")
  const dee = await made.agent("Dee", "Researcher")
  const team = await rpc<{ id: string }>(page, "sections.create", {
    serverId: made.serverId,
    kind: "agent",
    name: "Team",
  })
  await rpc(page, "places.move", { kind: "agent", id: dee.id, sectionId: team.id })
  // The channel "design" has a member with the role "Researcher". A channel never has a badge.
  await rpc(page, "channels.create", {
    serverId: made.serverId,
    name: "design",
    topic: "",
    memberIds: [ada.id, dee.id],
    leadId: null,
  })
  await expect(row(page, "Dee")).toBeVisible()

  // The badge: after the name, muted, only for an agent that has a role line.
  await expect(badge(page, "Ada")).toHaveText("Designer")
  await expect(badge(page, "Bo")).toHaveText("Writer")
  await expect(badge(page, "Cy")).toHaveCount(0)
  await expect(badge(page, "Dee")).toHaveText("Researcher")
  await expect(badge(page, "design")).toHaveCount(0)
  await expect(row(page, "design")).toBeVisible()
  const order = await row(page, "Ada").evaluate((el) => {
    const name = el.querySelector("[data-place-row] > span:nth-of-type(2)") ?? el.children[1]
    const role = el.querySelector("[data-testid=role-badge]")
    if (!name || !role) return false
    return name.getBoundingClientRect().right <= role.getBoundingClientRect().left
  })
  expect(order).toBe(true)
  // The whole role line is in the accessible name of the row, and in the note of the badge.
  await expect(row(page, "Ada")).toHaveAttribute("aria-label", /Ada, Role: Designer/)
  await expect(badge(page, "Ada")).toHaveAttribute("title", "Designer")
  await shot(page, "s107-10-en-badges")

  // The filter: the role line counts, a name still counts, Escape clears.
  await search(page).fill("design")
  expect(await rowNames(page)).toEqual(["design", "Ada"])
  await search(page).fill("writ")
  expect(await rowNames(page)).toEqual(["Bo"])
  await search(page).fill("Bo")
  expect(await rowNames(page)).toEqual(["Bo"])
  await search(page).fill("DESIGNER")
  expect(await rowNames(page)).toEqual(["Ada"])
  await shot(page, "s107-11-en-filter")
  await search(page).press("Escape")
  await expect(search(page)).toHaveValue("")
  expect((await rowNames(page)).sort()).toEqual(["Ada", "Bo", "Cy", "Dee", "design"].sort())

  // An agent in a collapsed section: the section opens and shows the agent. A channel with a member
  // of that role does not show. Escape collapses the section again.
  await page.getByTestId("user-section-toggle").click()
  await expect(row(page, "Dee")).toHaveCount(0)
  await search(page).fill("researcher")
  await expect(row(page, "Dee")).toBeVisible()
  expect(await rowNames(page)).toEqual(["Dee"])
  await shot(page, "s107-12-en-section")
  await search(page).press("Escape")
  await expect(row(page, "Dee")).toHaveCount(0)
  await page.getByTestId("user-section-toggle").click()

  // The badge follows the role line at once: remove the role of Ada, and the badge leaves.
  await rpc(page, "agents.update", { id: ada.id, patch: { role: "Qa tester" } })
  await expect(badge(page, "Ada")).toHaveText("Qa tester")
  await rpc(page, "agents.update", { id: ada.id, patch: { role: "" } })
  await expect(badge(page, "Ada")).toHaveCount(0)
  await rpc(page, "agents.update", { id: ada.id, patch: { role: "Qa tester" } })
  await expect(badge(page, "Ada")).toHaveText("Qa tester")

  // Narrowest place list: a long role is cut with an ellipsis after a short name, and the unread
  // count stays at the right end. A very long name keeps the room: the badge hides.
  await createAgent(page, "Mia")
  await rpc(page, "agents.update", {
    id: (
      await rpc<{ id: string; name: string }[]>(page, "agents.list", {
        serverId: made.serverId,
        archived: false,
      })
    ).find((a) => a.name === "Mia")?.id,
    patch: { role: "Reads every pull request the team opens and writes notes on it" },
  })
  const longName = `${"Longname-".repeat(4)}abcd`
  expect(longName).toHaveLength(40)
  await createAgent(page, longName)
  await rpc(page, "agents.update", {
    id: (
      await rpc<{ id: string; name: string }[]>(page, "agents.list", {
        serverId: made.serverId,
        archived: false,
      })
    ).find((a) => a.name === longName)?.id,
    patch: { role: "Reads every pull request" },
  })
  for (const name of ["Mia", longName]) {
    await row(page, "Ada").click()
    await row(page, name).click()
    await page.getByTestId("composer-input").fill("slow for unread")
    await page.getByTestId("composer-input").press("Enter")
    await row(page, "Ada").click()
    await expect(row(page, name)).toContainText("1", { timeout: 15_000 })
  }
  const resizer = page.getByTestId("place-list-resizer")
  await resizer.focus()
  for (let i = 0; i < 4; i++) await resizer.press("ArrowLeft")
  await expect
    .poll(() => page.getByTestId("place-list").evaluate((el) => el.getBoundingClientRect().width))
    .toBe(200)
  const shortRow = row(page, "Mia")
  await expect(badge(page, "Mia")).toBeVisible()
  const cutBadge = await badge(page, "Mia").evaluate((el) => el.scrollWidth > el.clientWidth)
  expect(cutBadge).toBe(true)
  // The name is whole, the badge ends before the count, the count is at the right end.
  const shortBoxes = await shortRow.evaluate((el) => {
    const box = (selector: string) => el.querySelector(selector)?.getBoundingClientRect()
    const name = el.querySelector("[data-with-badge]")
    const nameBox = name?.getBoundingClientRect()
    const unread = [...el.querySelectorAll("span")].find((s) => s.textContent === "1")
    return {
      nameCut: name ? name.scrollWidth > name.clientWidth : true,
      nameRight: nameBox?.right ?? 0,
      badgeLeft: box("[data-testid=role-badge]")?.left ?? 0,
      badgeRight: box("[data-testid=role-badge]")?.right ?? 0,
      unreadLeft: unread?.getBoundingClientRect().left ?? 0,
      unreadRight: unread?.getBoundingClientRect().right ?? 0,
      rowRight: el.getBoundingClientRect().right,
    }
  })
  expect(shortBoxes.nameCut).toBe(false)
  expect(shortBoxes.nameRight).toBeLessThanOrEqual(shortBoxes.badgeLeft)
  expect(shortBoxes.badgeRight).toBeLessThanOrEqual(shortBoxes.unreadLeft)
  expect(shortBoxes.rowRight - shortBoxes.unreadRight).toBeLessThanOrEqual(12)
  const longRow = row(page, longName)
  await expect(badge(page, longName)).toBeHidden()
  const longBoxes = await longRow.evaluate((el) => {
    const name = el.querySelector("[data-with-badge]") as HTMLElement
    const unread = [...el.querySelectorAll("span")].find((s) => s.textContent === "1")
    return {
      nameCut: name.scrollWidth > name.clientWidth,
      unreadRight: unread?.getBoundingClientRect().right ?? 0,
      rowRight: el.getBoundingClientRect().right,
    }
  })
  // 40 characters do not fit in 200 px: the name is cut with an ellipsis, the badge hides, the
  // count stays at the right end.
  expect(longBoxes.nameCut).toBe(true)
  expect(longBoxes.rowRight - longBoxes.unreadRight).toBeLessThanOrEqual(12)
  await shot(page, "s107-13-en-narrow")
  await smallShot(app, page, "s107-13-en-narrow-small")

  // The compact place list shows the badge too, on a row of 28 px.
  await rpc(page, "settings.update", { compactPlaces: true })
  await expect
    .poll(() => row(page, "Ada").evaluate((el) => el.getBoundingClientRect().height))
    .toBe(28)
  await expect(badge(page, "Ada")).toHaveText("Qa tester")
  await expect(badge(page, "Bo")).toHaveText("Writer")
  await expect(badge(page, "Dee")).toHaveText("Researcher")
  await shot(page, "s107-14-en-compact")
  await rpc(page, "settings.update", { compactPlaces: false })
  await expect
    .poll(() => row(page, "Ada").evaluate((el) => el.getBoundingClientRect().height))
    .toBe(38)

  // Korean: the badge is the text of the user; the accessible name uses the catalogue.
  await app.close()
  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
  await resizeWindow(app, 1100, 800)
  await expect(badge(page, "Ada")).toHaveText("Qa tester")
  await expect(row(page, "Ada")).toHaveAttribute("aria-label", /Ada, 역할: Qa tester/)
  await shot(page, "s107-10-ko-badges")
  await search(page).fill("qa")
  expect(await rowNames(page)).toEqual(["Ada"])
  await shot(page, "s107-11-ko-filter")
  await smallShot(app, page, "s107-11-ko-filter-small")
  await app.close()
  await mock.close()
})

// A linked computer (spec 012, 002): MacBook 1 (the client) opens MacBook 2 (the server). The places
// of the server carry the role line of each agent, a change is pushed, the field works with the
// roles of the server, and a client without the switch "Can create and change agents" sees the chip
// with no "Remove" and no list.

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const clientRow = (page: Page, name: string) =>
  page.locator(`[data-testid=client-row][data-name="${name}"]`)

/** MacBook 2 shows a code; MacBook 1 connects one way, and the switch to change agents is on. */
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
  await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

test("role line on a linked computer: badge, push, the field, and the profile without the switch", async () => {
  test.setTimeout(240_000)
  const ports = await freePortPair()
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(ports[1]))
  const dataOne = freshUserData()
  let one = await launch(dataOne, envFor(ports[0]))
  await resizeWindow(two.app, 1200, 860)
  await resizeWindow(one.app, 1200, 860)
  try {
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)
    const made = await seed(two.page)
    const ada = await made.agent("Ada", "Designer")
    await made.agent("Bo", "Writer")
    await made.agent("Cy", "")

    await pairOneWay(one, two)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()

    // The places of the server carry the role line. An agent with none has no badge.
    await expect(badge(one.page, "Ada")).toHaveText("Designer")
    await expect(badge(one.page, "Bo")).toHaveText("Writer")
    await expect(badge(one.page, "Cy")).toHaveCount(0)
    // The filter looks at the role line of the linked places too.
    await search(one.page).fill("writ")
    expect(await rowNames(one.page)).toEqual(["Bo"])
    await search(one.page).press("Escape")

    // A change of the role line on the server is pushed to the client, and a change of the name too.
    await rpc(two.page, "agents.update", { id: ada.id, patch: { role: "Lead designer" } })
    await expect(badge(one.page, "Ada")).toHaveText("Lead designer")
    await rpc(two.page, "agents.update", { id: ada.id, patch: { name: "Ada L" } })
    await expect(badge(one.page, "Ada L")).toHaveText("Lead designer")
    await rpc(two.page, "agents.update", { id: ada.id, patch: { name: "Ada", role: "Designer" } })
    await expect(badge(one.page, "Ada")).toHaveText("Designer")

    // The client has the switch: the field works with the roles of the server.
    await one.page.getByTestId("new-agent").click()
    await openList(one.page)
    expect(await optionsOf(one.page)).toEqual([
      { role: "Designer", count: 1 },
      { role: "Writer", count: 1 },
    ])
    await filterBox(one.page).fill("Qa tester")
    await filterBox(one.page).press("Enter")
    await expect(chip(one.page)).toHaveText("Qa tester")
    await one.page.getByTestId("agent-name").fill("Quinn")
    await one.page.getByTestId("model-model").waitFor()
    await one.page.getByTestId("agent-submit").click()
    await one.page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
    await expect(badge(one.page, "Quinn")).toHaveText("Qa tester")
    await expect(badge(two.page, "Quinn")).toHaveText("Qa tester")
    await shot(one.page, "s107-20-en-linked-badges")

    // The user of MacBook 2 turns the switch off: the profile of an agent with a role shows the chip
    // with no "Remove" button and no list. An agent with no role shows no field.
    await openDevices(two.page)
    await clientRow(two.page, "MacBook 1").getByTestId("client-can-change").click()
    await expect(clientRow(two.page, "MacBook 1").getByTestId("client-can-change")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await closeSettings(two.page)
    await expect(one.page.getByTestId("new-agent")).toHaveCount(0)
    await row(one.page, "Ada").click()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-profile-view")).toBeVisible()
    await expect(one.page.getByTestId("agent-view-role")).toHaveText("Designer")
    await expect(one.page.getByTestId("agent-role-remove")).toHaveCount(0)
    await expect(one.page.getByTestId("agent-role-open")).toHaveCount(0)
    await one.page.getByTestId("agent-view-role").click()
    await expect(one.page.getByTestId("agent-role-list")).toHaveCount(0)
    await shot(one.page, "s107-21-en-linked-readonly")
    await one.page.keyboard.press("Escape")
    await expect(one.page.getByTestId("agent-profile")).toBeHidden()
    await row(one.page, "Cy").click()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-profile-view")).toBeVisible()
    await expect(one.page.getByTestId("agent-view-role")).toHaveCount(0)
    await one.page.keyboard.press("Escape")

    // Korean on the client: the same states, the badge is the text of the user.
    await one.app.close()
    one = await launch(dataOne, envFor(ports[0], { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
    await resizeWindow(one.app, 1200, 860)
    await tile(one.page, "MacBook 2").click()
    await expect(badge(one.page, "Ada")).toHaveText("Designer")
    await shot(one.page, "s107-20-ko-linked-badges")
    await row(one.page, "Ada").click()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-view-role")).toHaveText("Designer")
    await smallShot(
      one.app,
      one.page,
      "s107-21-ko-linked-readonly-small",
      one.page.getByTestId("agent-view-role"),
    )
  } finally {
    await one.app.close().catch(() => undefined)
    await two.app.close().catch(() => undefined)
    await mock.close()
  }
})
