import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, type Launched, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import { closeSettings, envFor, openDevices, rpc, send, setName, settled } from "./sync-helpers.ts"

// Slice S53: the five starters of the new agent form (spec 002), the paused routine (009) and the
// skill (017) that a starter makes on Create, the note in the chat when a limit stops a part, and
// the rule that a linked device gets the three fields only (012).

interface AgentInfo {
  id: string
  name: string
  role: string
  instructions: string
  model: unknown
}
interface RoutineInfo {
  id: string
  agentId: string
  name: string
  prompt: string
  enabled: boolean
  place: { kind: string }
  schedule: { kind: string; days?: number[]; time?: string } | null
}
interface SkillRow {
  name: string
  description: string
  instructions: string
  agents: string | null
  enabled: number
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await serverOf(page), archived: false })
const routinesOf = async (page: Page) =>
  rpc<RoutineInfo[]>(page, "routines.list", { serverId: await serverOf(page) })

/** The skills in the database of a data folder. The window has no method to list them yet. */
const skillsIn = (userData: string) => {
  const db = new DatabaseSync(join(userData, "robot.db"), { readOnly: true })
  try {
    return db
      .prepare(
        "SELECT name, description, instructions, agents, enabled FROM skill ORDER BY created_at, rowid",
      )
      .all() as unknown as SkillRow[]
  } finally {
    db.close()
  }
}
const agentsOfSkill = (skill: SkillRow | undefined) =>
  JSON.parse(skill?.agents ?? "null") as string[] | null

const choices = (page: Page) => page.getByRole("group", { name: /Start from|시작 방법/ })

const openForm = async (page: Page) => {
  await page.getByTestId("new-agent").click()
  await expect(page.getByTestId("agent-form")).toBeVisible()
}

/** Presses Create and waits until the box is gone and the chat of the new agent shows. */
const create = async (page: Page, name: string) => {
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("conversation-header")).toContainText(name)
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
}

test("starters: the choice, the filled fields, the paused routine and the skill", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)

  // The choice lists Blank and then the five starters. Each starter shows its job name, one line
  // about the job, and a muted line about what else it makes.
  await openForm(page)
  const buttons = choices(page).getByRole("button")
  await expect(buttons).toHaveCount(6)
  const expected = [
    ["Blank"],
    ["Assistant", "Answers everyday questions and helps you write.", "Makes nothing else"],
    [
      "Briefer",
      "Gives you a short briefing on the topics you follow.",
      "A paused routine, 1 skill",
    ],
    ["Researcher", "Looks up facts and checks each one against sources.", "1 skill"],
    ["Reviewer", "Reads code changes and finds problems in them.", "1 skill"],
    ["Organizer", "Sorts and names the files in its workspace.", "1 skill"],
  ]
  for (const [index, lines] of expected.entries())
    for (const line of lines) await expect(buttons.nth(index)).toContainText(line)
  await expect(page.getByTestId("starter-briefer-extras")).toHaveText("A paused routine, 1 skill")
  await expect(page.getByTestId("starter-assistant-extras")).toHaveText("Makes nothing else")
  await expect(page.getByTestId("starter-blank")).toHaveAttribute("aria-pressed", "true")
  // The old three templates are gone.
  await expect(page.getByText("General assistant")).toHaveCount(0)
  await expect(page.getByText("Code reviewer")).toHaveCount(0)
  // Nothing else is made before Create, and Blank has no list of extras.
  await expect(page.getByTestId("starter-makes")).toHaveCount(0)
  await shot(page, "s53-01-choice")

  // Briefer fills the three fields, and the form tells what Create makes, with the schedule in
  // words.
  await page.getByTestId("starter-briefer").click()
  await expect(page.getByTestId("starter-briefer")).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("starter-blank")).toHaveAttribute("aria-pressed", "false")
  await expect(page.getByTestId("agent-name")).toHaveValue("Briefer")
  await expect(page.getByTestId("agent-role")).toHaveValue(
    "Prepares a short briefing on the topics its user follows.",
  )
  await expect(page.getByTestId("agent-instructions")).toHaveValue(/10 lines or fewer/)
  await expect(page.getByTestId("agent-instructions")).toHaveValue(/Search the web/)
  await expect(page.getByTestId("starter-makes-routine")).toContainText("Weekday briefing")
  await expect(page.getByTestId("starter-makes-routine")).toContainText(
    "Mon, Tue, Wed, Thu, Fri at 08:00",
  )
  await expect(page.getByTestId("starter-makes-routine")).toContainText("paused")
  await expect(page.getByTestId("starter-makes-skill")).toContainText("Brief me now")
  await shot(page, "s53-02-briefer-picked")

  // The pick made nothing yet.
  expect(await routinesOf(page)).toEqual([])
  expect(skillsIn(userData)).toEqual([])

  await create(page, "Briefer")
  await expect(page.getByTestId("chat-start")).toContainText(
    "Prepares a short briefing on the topics its user follows.",
  )
  // A starter sets no model. Nothing was left out, so the chat has no note.
  await expect(page.getByTestId("chat-header-model")).toHaveText("No model")
  await expect(page.getByTestId("note-line")).toHaveCount(0)

  const [briefer] = await agentsOf(page)
  const routines = await routinesOf(page)
  expect(routines).toHaveLength(1)
  expect(routines[0]).toMatchObject({
    agentId: briefer?.id,
    name: "Weekday briefing",
    enabled: false,
    place: { kind: "agent" },
    schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
  })
  const skills = skillsIn(userData)
  expect(skills).toHaveLength(1)
  expect(skills[0]).toMatchObject({ name: "Brief me now", enabled: 1 })
  expect(agentsOfSkill(skills[0])).toEqual([briefer?.id as string])

  // The routine is on the Routines page, paused, with its schedule in words.
  await page.getByTestId("page-workflows").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(1)
  await expect(page.getByTestId("routine-card")).toContainText("Weekday briefing")
  await expect(page.getByTestId("routine-card")).toContainText("Mon, Tue, Wed, Thu, Fri at 08:00")
  // The switch is off, so the card shows no next run. It is no pause after failed runs.
  await expect(page.getByTestId("routine-enabled")).toHaveAttribute("aria-checked", "false")
  await expect(page.getByTestId("routine-card")).toHaveAttribute("data-enabled", "false")
  await expect(page.getByTestId("routine-next")).toHaveCount(0)
  await expect(page.getByTestId("routine-paused")).toHaveCount(0)
  await shot(page, "s53-03-paused-routine")
  await app.close()
})

test("starters: the user can change the fields, Blank clears them, and a second Researcher gets a numbered skill", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)

  // Pick Reviewer, change its role line, press Create: the agent keeps the changed line.
  await openForm(page)
  await page.getByTestId("starter-reviewer").click()
  await expect(page.getByTestId("agent-name")).toHaveValue("Reviewer")
  await expect(page.getByTestId("agent-instructions")).toHaveValue(/Do not change a file/)
  await page.getByTestId("agent-role").fill("Reads pull requests for the team.")
  await create(page, "Reviewer")
  await expect(page.getByTestId("chat-start")).toContainText("Reads pull requests for the team.")
  const [reviewer] = await agentsOf(page)
  expect(reviewer?.role).toBe("Reads pull requests for the team.")
  expect(skillsIn(userData).map((s) => s.name)).toEqual(["Review latest change"])
  expect(await routinesOf(page)).toEqual([])

  // Pick a starter, then Blank: the three fields that the starter filled are empty again, and the
  // form no longer tells of extra setup.
  await openForm(page)
  await page.getByTestId("starter-briefer").click()
  await expect(page.getByTestId("starter-makes")).toBeVisible()
  await page.getByTestId("starter-blank").click()
  await expect(page.getByTestId("starter-blank")).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByTestId("agent-name")).toHaveValue("")
  await expect(page.getByTestId("agent-role")).toHaveValue("")
  await expect(page.getByTestId("agent-instructions")).toHaveValue("")
  await expect(page.getByTestId("starter-makes")).toHaveCount(0)
  // Blank makes a plain agent, with no routine and no skill.
  await page.getByTestId("agent-name").fill("Plain")
  await create(page, "Plain")
  expect(await routinesOf(page)).toEqual([])
  expect(skillsIn(userData).map((s) => s.name)).toEqual(["Review latest change"])

  // The Assistant makes nothing else: no routine and no skill.
  await openForm(page)
  await page.getByTestId("starter-assistant").click()
  await expect(page.getByTestId("starter-makes")).toHaveCount(0)
  await page.getByTestId("agent-name").fill("Helper")
  await create(page, "Helper")
  expect(await routinesOf(page)).toEqual([])
  expect(skillsIn(userData)).toHaveLength(1)

  // Two agents from Researcher: the second skill gets a number, and each is for its own agent.
  await openForm(page)
  await page.getByTestId("starter-researcher").click()
  await create(page, "Researcher")
  await openForm(page)
  await page.getByTestId("starter-researcher").click()
  // The name of the first agent is taken, so the form asks for another name and makes nothing.
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-error")).toBeVisible()
  expect(skillsIn(userData).map((s) => s.name)).toEqual(["Review latest change", "Check a claim"])
  await page.getByTestId("agent-name").fill("Ruth")
  await create(page, "Ruth")

  const agents = await agentsOf(page)
  const idOf = (name: string) => agents.find((a) => a.name === name)?.id as string
  const skills = skillsIn(userData)
  expect(skills.map((s) => s.name)).toEqual([
    "Review latest change",
    "Check a claim",
    "Check a claim 2",
  ])
  expect(skills.map((s) => s.enabled)).toEqual([1, 1, 1])
  expect(agentsOfSkill(skills[0])).toEqual([idOf("Reviewer")])
  expect(agentsOfSkill(skills[1])).toEqual([idOf("Researcher")])
  expect(agentsOfSkill(skills[2])).toEqual([idOf("Ruth")])
  // The agents that took no skill hold none.
  for (const name of ["Plain", "Helper"])
    expect(skills.filter((s) => agentsOfSkill(s)?.includes(idOf(name)))).toEqual([])
  await app.close()
})

test("starters: the text follows the language at the moment of the pick", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)

  // Picked in English. The language changes before Create. The skill keeps the English text.
  await openForm(page)
  await page.getByTestId("starter-organizer").click()
  await expect(page.getByTestId("agent-name")).toHaveValue("Organizer")
  await rpc(page, "settings.update", { language: "ko" })
  await expect(page.getByTestId("agent-submit")).toHaveText("에이전트 만들기")
  await expect(page.getByTestId("agent-name")).toHaveValue("Organizer")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0)
  expect(skillsIn(userData).map((s) => s.name)).toEqual(["Tidy a folder"])

  // Picked in Korean: the choice, the fields and the skill are Korean.
  await openForm(page)
  await expect(page.getByTestId("starter-organizer")).toContainText("정리 도우미")
  await expect(page.getByTestId("starter-organizer-extras")).toHaveText("스킬 1개")
  await expect(page.getByTestId("starter-assistant-extras")).toHaveText("추가로 만드는 것 없음")
  await expect(page.getByTestId("starter-briefer-extras")).toHaveText(
    "일시 중지된 루틴 1개, 스킬 1개",
  )
  await page.getByTestId("starter-organizer").click()
  await expect(page.getByTestId("agent-name")).toHaveValue("정리 도우미")
  await expect(page.getByTestId("agent-instructions")).toHaveValue(/절대 삭제하지 않아요/)
  await shot(page, "s53-04-korean-choice")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0)
  expect(skillsIn(userData).map((s) => s.name)).toEqual(["Tidy a folder", "폴더 정리"])

  // The Briefer in Korean makes a Korean routine and a Korean skill.
  await openForm(page)
  await page.getByTestId("starter-briefer").click()
  await expect(page.getByTestId("starter-makes-routine")).toContainText("평일 아침 브리핑")
  await expect(page.getByTestId("starter-makes-routine")).toContainText("08:00")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0)
  const routines = await routinesOf(page)
  expect(routines.map((r) => r.name)).toEqual(["평일 아침 브리핑"])
  expect(routines[0]?.prompt).toMatch(/브리핑/)
  expect(routines[0]?.enabled).toBe(false)
  expect(skillsIn(userData).map((s) => s.name)).toEqual([
    "Tidy a folder",
    "폴더 정리",
    "지금 브리핑",
  ])
  await app.close()
})

test("starters: at 50 routines the agent is made without its routine, and the first note says why", async () => {
  test.setTimeout(180_000)
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)
  const serverId = await serverOf(page)
  const filler = await rpc<AgentInfo>(page, "agents.create", {
    serverId,
    name: "Filler",
    role: "",
    instructions: "",
  })
  for (let n = 0; n < 50; n++)
    await rpc(page, "routines.create", {
      serverId,
      agentId: filler.id,
      name: `Filler ${n}`,
      prompt: "x",
      schedule: { kind: "daily", times: ["09:00"] },
      place: { kind: "agent" },
    })
  expect(await routinesOf(page)).toHaveLength(50)

  await openForm(page)
  await page.getByTestId("starter-briefer").click()
  await create(page, "Briefer")

  // The agent exists, no routine was made, and the skill was.
  expect(await routinesOf(page)).toHaveLength(50)
  const briefer = (await agentsOf(page)).find((a) => a.name === "Briefer")
  expect(briefer).toBeDefined()
  const skills = skillsIn(userData)
  expect(skills.map((s) => s.name)).toEqual(["Brief me now"])
  expect(agentsOfSkill(skills[0])).toEqual([briefer?.id as string])
  // The first note in its chat says what was not made and why.
  const notes = page.getByTestId("note-line")
  await expect(notes).toHaveCount(1)
  await expect(notes.first()).toContainText(
    "Not made: the routine “Weekday briefing”. This server already has 50 routines, the most that it can hold.",
  )
  await shot(page, "s53-05-note-routine-limit")

  // The note is in the interface language at the time of the view.
  await rpc(page, "settings.update", { language: "ko" })
  await expect(notes.first()).toContainText("만들지 못한 루틴: “Weekday briefing”")
  await expect(notes.first()).toContainText("50개")
  await app.close()
})

test("starters: at 100 skills the agent is made without its skill, and the first note says why", async () => {
  test.setTimeout(240_000)
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)
  const serverId = await serverOf(page)
  // 100 agents with a starter skill make 100 skills. The name of each skill gets a number.
  for (let n = 0; n < 100; n++)
    await rpc(page, "agents.createFromStarter", {
      serverId,
      name: `Bot ${n}`,
      role: "",
      instructions: "",
      starter: {
        routine: null,
        skill: { name: "Check a claim", description: "", instructions: "Check the claim." },
      },
    })
  expect(skillsIn(userData)).toHaveLength(100)

  await openForm(page)
  await page.getByTestId("starter-briefer").click()
  await create(page, "Briefer")

  // The agent and its routine exist. The skill was not made.
  expect(skillsIn(userData)).toHaveLength(100)
  expect((await routinesOf(page)).map((r) => r.name)).toEqual(["Weekday briefing"])
  const notes = page.getByTestId("note-line")
  await expect(notes).toHaveCount(1)
  await expect(notes.first()).toContainText(
    "Not made: the skill “Brief me now”. This server already has 100 skills, the most that it can hold.",
  )
  await shot(page, "s53-06-note-skill-limit")
  await app.close()
})

test("starters: the main process checks the strings of the request", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)
  const serverId = await serverOf(page)
  const base = { serverId, name: "Morning", role: "", instructions: "" }
  const routine = { name: "Own routine", prompt: "Own prompt." }
  const skill = { name: "Own skill", description: "", instructions: "Own steps." }

  // A wrong string is refused, and nothing is made: no agent, no routine, no skill.
  const wrong = [
    { routine: { ...routine, name: "x".repeat(61) }, skill },
    { routine: { ...routine, prompt: "  " }, skill },
    { routine, skill: { ...skill, name: "" } },
    { routine, skill: { ...skill, description: "x".repeat(141) } },
    { routine, skill: { ...skill, instructions: "" } },
    { routine },
  ]
  for (const starter of wrong)
    await expect(rpc(page, "agents.createFromStarter", { ...base, starter })).rejects.toThrow(
      "invalid_input",
    )
  expect(await agentsOf(page)).toEqual([])
  expect(await routinesOf(page)).toEqual([])
  expect(skillsIn(userData)).toEqual([])

  // A request cannot turn the routine on, or change its schedule, its place or the agents of the
  // skill: the app sets them itself.
  await rpc(page, "agents.createFromStarter", {
    ...base,
    starter: {
      routine: {
        ...routine,
        enabled: true,
        schedule: { kind: "every", minutes: 1, from: 0 },
        place: { kind: "channel", channelId: "x" },
      },
      skill: { ...skill, enabled: false, agentIds: null },
    },
  })
  const [made] = await agentsOf(page)
  const [row] = await routinesOf(page)
  expect(row).toMatchObject({
    agentId: made?.id,
    name: "Own routine",
    prompt: "Own prompt.",
    enabled: false,
    place: { kind: "agent" },
    schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" },
  })
  const [kept] = skillsIn(userData)
  expect(kept).toMatchObject({ name: "Own skill", enabled: 1 })
  expect(agentsOfSkill(kept)).toEqual([made?.id as string])
  await app.close()
})

test("starters: the model does not read the note", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  const serverId = await serverOf(page)
  const filler = await rpc<AgentInfo>(page, "agents.create", {
    serverId,
    name: "Filler",
    role: "",
    instructions: "",
  })
  for (let n = 0; n < 50; n++)
    await rpc(page, "routines.create", {
      serverId,
      agentId: filler.id,
      name: `Filler ${n}`,
      prompt: "x",
      schedule: { kind: "daily", times: ["09:00"] },
      place: { kind: "agent" },
    })

  await openForm(page)
  await page.getByTestId("starter-briefer").click()
  await page.getByTestId("model-model").waitFor()
  await create(page, "Briefer")
  await expect(page.getByTestId("note-line")).toHaveCount(1)

  const before = mock.requests.length
  await send(page, "Hello there")
  await settled(page)
  const turn = JSON.stringify(
    mock.requests
      .slice(before)
      .filter((r) => r.path.endsWith("/chat/completions"))
      .at(-1)?.body,
  )
  expect(turn).toContain("Hello there")
  // The instructions of the starter reach the model, and the note does not.
  expect(turn).toContain("Search the web")
  expect(turn).not.toContain("Weekday briefing")
  expect(turn).not.toContain("Not made")
  await expect(page.getByTestId("note-line")).toHaveCount(1)
  await app.close()
  await mock.close()
})

// ---- A linked device gets the three fields only (spec 012) ----

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const placeOf = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]", { hasText: new RegExp(`^${name}`) })

/** MacBook 2 shows a code; MacBook 1 connects one way, and may change agents on MacBook 2. */
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

test("starters: a linked device gets the three fields only", async () => {
  test.setTimeout(240_000)
  const ports = await freePortPair()
  const dataTwo = freshUserData()
  const two = await launch(dataTwo, envFor(ports[1], {}))
  const one = await launch(freshUserData(), envFor(ports[0], {}))
  await resizeWindow(two.app, 1200, 860)
  await resizeWindow(one.app, 1200, 860)
  try {
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)
    await pairOneWay(one, two)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()

    // The choice shows the job names and the job lines, and no muted line.
    await openForm(one.page)
    await expect(choices(one.page).getByRole("button")).toHaveCount(6)
    await expect(one.page.getByTestId("starter-briefer")).toContainText("Briefer")
    await expect(one.page.getByTestId("starter-briefer")).toContainText(
      "Gives you a short briefing on the topics you follow.",
    )
    for (const id of ["assistant", "briefer", "researcher", "reviewer", "organizer"])
      await expect(one.page.getByTestId(`starter-${id}-extras`)).toHaveCount(0)

    // The pick fills the three fields. The form does not list a routine or a skill.
    await one.page.getByTestId("starter-briefer").click()
    await expect(one.page.getByTestId("agent-name")).toHaveValue("Briefer")
    await expect(one.page.getByTestId("agent-role")).toHaveValue(
      "Prepares a short briefing on the topics its user follows.",
    )
    await expect(one.page.getByTestId("agent-instructions")).toHaveValue(/Search the web/)
    await expect(one.page.getByTestId("starter-makes")).toHaveCount(0)
    await shot(one.page, "s53-07-linked-form")
    await one.page.getByTestId("agent-submit").click()
    await expect(one.page.getByTestId("chat-start").filter({ hasText: "Briefer" })).toBeVisible()
    await expect(placeOf(two.page, "Briefer")).toBeVisible()

    // MacBook 2 holds the agent with the three fields, and no routine, no skill and no note.
    const made = (await agentsOf(two.page)).find((a) => a.name === "Briefer")
    expect(made?.role).toBe("Prepares a short briefing on the topics its user follows.")
    expect(made?.instructions).toContain("Search the web")
    expect(await routinesOf(two.page)).toEqual([])
    expect(skillsIn(dataTwo)).toEqual([])
    await placeOf(two.page, "Briefer").click()
    await expect(two.page.getByTestId("chat-start")).toBeVisible()
    await expect(two.page.getByTestId("note-line")).toHaveCount(0)

    // The request that makes the extra setup is not one that a linked device may call.
    const serverId = await one.page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const result = await (window as any).robot.invoke("servers.list")
      return (result.value as { id: string; kind: string }[]).find((s) => s.kind === "linked")?.id
    })
    const refused = await one.page.evaluate(
      async ([id]) => {
        // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
        const r = await (window as any).robot.invoke(
          "agents.createFromStarter",
          {
            serverId: id,
            name: "Sneaky",
            role: "",
            instructions: "",
            starter: { routine: { name: "Weekday briefing", prompt: "Go." }, skill: null },
          },
          id,
        )
        return r.ok ? "ok" : (r.error.code as string)
      },
      [serverId],
    )
    expect(refused).toBe("not_allowed")
    expect((await agentsOf(two.page)).map((a) => a.name)).toEqual(["Briefer"])
    expect(await routinesOf(two.page)).toEqual([])
  } finally {
    await one.app.close()
    await two.app.close()
  }
})
