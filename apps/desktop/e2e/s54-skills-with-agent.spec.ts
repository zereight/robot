import { expect, type Locator, type Page, test } from "@playwright/test"
import { freshUserData, type Launched, launch, resizeWindow, shot } from "./harness.ts"
import { rpc } from "./sync-helpers.ts"

// Slice S54: skills go with their only agent (spec 002 flow 9, spec 017 "Rules"). The confirm text
// of the delete of an agent names how many skills are deleted too, the agent leaves the list of
// every other skill, and archive changes no skill. No chat is needed, so no stand-in model runs.

interface Made {
  readonly id: string
  readonly name: string
}
interface SkillInfo {
  readonly name: string
  readonly agentIds: readonly string[] | null
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string

const makeAgent = async (page: Page, name: string) =>
  rpc<Made>(page, "agents.create", {
    serverId: await serverOf(page),
    name,
    role: "",
    instructions: "Be brief.",
  })

const makeSkill = async (page: Page, name: string, agentIds: readonly string[] | null) =>
  rpc(page, "skills.create", {
    serverId: await serverOf(page),
    name,
    description: "",
    instructions: "Do the work.",
    agentIds,
  })

const skillsOf = async (page: Page) =>
  (await rpc<SkillInfo[]>(page, "skills.list", { serverId: await serverOf(page) })).map((s) => ({
    name: s.name,
    agentIds: s.agentIds,
  }))

const rowNamed = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`)

const archivedRow = (page: Page, name: string) =>
  page.locator("[data-testid^=archived-]").filter({ hasText: name })

/** Archives an agent from its profile, the way the user does it. */
const archiveFromProfile = async (page: Page, name: string) => {
  await rowNamed(page, name).click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("agent-archive").click()
  await expect(rowNamed(page, name)).toHaveCount(0)
}

const openArchive = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await expect(page.getByTestId("archive-section")).toBeVisible()
}
const openSkills = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-skills").click()
  await expect(page.getByTestId("skills-section")).toBeVisible()
}
const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings-close")).toHaveCount(0)
}

/** Opens the confirm of the delete of an archived agent. */
const askDelete = async (page: Page, name: string) => {
  await archivedRow(page, name).getByTestId("archive-delete").click()
  await expect(page.getByTestId("delete-confirm")).toBeVisible()
  await expect(page.getByTestId("delete-confirm")).toContainText(name)
}
const cancelDelete = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("delete-confirm")).toHaveCount(0)
}

/**
 * A shot at the smallest window that the app allows (480 by 400 px). The window goes back to its
 * size after the shot.
 */
const smallShot = async (app: Launched["app"], page: Page, name: string, focus: Locator) => {
  await resizeWindow(app, 480, 400)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(500)
  await focus.scrollIntoViewIfNeeded()
  await expect(focus).toBeVisible()
  await shot(page, name)
  await resizeWindow(app, 1100, 800)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1000)
}

test("the delete of an agent names its skills, and they go with it (en, ko)", async () => {
  test.setTimeout(240_000)
  const userData = freshUserData()
  let { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1100, 800)

  // --- Set-up: Ada, Bo and Cy; skills only for Ada, for Ada and Bo, and for all agents -------
  const ada = await makeAgent(page, "Ada")
  const bo = await makeAgent(page, "Bo")
  await makeAgent(page, "Cy")
  await makeSkill(page, "Only Ada", [ada.id])
  await makeSkill(page, "Ada and Bo", [ada.id, bo.id])
  await makeSkill(page, "Everyone", null)
  // A starter makes a skill for its new agent only (spec 002): it goes with that agent too.
  await page.getByTestId("new-agent").click()
  await page.getByTestId("starter-researcher").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("conversation-header")).toContainText("Researcher")
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
  expect((await skillsOf(page)).map((s) => s.name).sort()).toEqual([
    "Ada and Bo",
    "Check a claim",
    "Everyone",
    "Only Ada",
  ])

  // --- Archive changes no skill ---------------------------------------------------------------
  const before = await skillsOf(page)
  await archiveFromProfile(page, "Ada")
  expect(await skillsOf(page)).toEqual(before)

  // --- The confirm text names 1 skill: the one that is only for Ada ---------------------------
  await openArchive(page)
  await askDelete(page, "Ada")
  await expect(page.getByTestId("delete-skills-line")).toHaveText(
    "1 skill that is only for Ada is deleted too.",
  )
  await shot(page, "s54-01-confirm-one")
  await smallShot(app, page, "s54-01-confirm-one-small", page.getByTestId("delete-confirm-button"))
  // Cancel deletes nothing.
  await cancelDelete(page)
  expect(await skillsOf(page)).toEqual(before)

  // --- Delete: the skill that was only for Ada is gone, the others stay ----------------------
  await askDelete(page, "Ada")
  await page.getByTestId("delete-confirm-button").click()
  await expect(archivedRow(page, "Ada")).toHaveCount(0)
  await expect(page.getByTestId("archive-section")).toContainText("No archived agents.")
  expect(await skillsOf(page)).toEqual([
    { name: "Ada and Bo", agentIds: [bo.id] },
    { name: "Check a claim", agentIds: [expect.any(String)] },
    { name: "Everyone", agentIds: null },
  ])
  // The list of skills shows it at once: Bo is the only agent of the shared skill.
  await closeSettings(page)
  await openSkills(page)
  await expect(page.getByTestId("skill-row")).toHaveCount(3)
  await expect(page.locator("[data-testid=skill-row][data-skill='Only Ada']")).toHaveCount(0)
  await expect(
    page
      .locator("[data-testid=skill-row][data-skill='Ada and Bo']")
      .getByTestId("skill-row-agents"),
  ).toHaveText("Bo")
  await expect(
    page.locator("[data-testid=skill-row][data-skill='Everyone']").getByTestId("skill-row-agents"),
  ).toHaveText("All agents")
  await shot(page, "s54-02-skills-after")
  await closeSettings(page)

  // --- Many: "Ada and Bo" is only for Bo now, and Bo has two skills of its own ----------------
  await makeSkill(page, "Only Bo", [bo.id])
  await makeSkill(page, "Bo again", [bo.id])
  await archiveFromProfile(page, "Bo")
  await openArchive(page)
  await askDelete(page, "Bo")
  await expect(page.getByTestId("delete-skills-line")).toHaveText(
    "3 skills that are only for Bo are deleted too.",
  )
  await shot(page, "s54-03-confirm-many")
  // The count follows a change of the skills while the dialog is open.
  const again = (
    await rpc<{ id: string; name: string }[]>(page, "skills.list", {
      serverId: await serverOf(page),
    })
  ).find((s) => s.name === "Bo again")
  await rpc(page, "skills.delete", { id: again?.id })
  await expect(page.getByTestId("delete-skills-line")).toHaveText(
    "2 skills that are only for Bo are deleted too.",
  )
  await cancelDelete(page)

  // --- None: an agent with no skill of its own has no such line -------------------------------
  await closeSettings(page)
  await archiveFromProfile(page, "Cy")
  await openArchive(page)
  await askDelete(page, "Cy")
  await expect(page.getByTestId("delete-skills-line")).toHaveCount(0)
  await expect(page.getByTestId("delete-confirm")).not.toContainText("skill")
  await shot(page, "s54-04-confirm-none")
  await cancelDelete(page)
  await closeSettings(page)

  // --- Korean: the same text from the catalogue, then the delete -------------------------------
  await app.close()
  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
  await resizeWindow(app, 1100, 800)
  await openArchive(page)
  await askDelete(page, "Bo")
  await expect(page.getByTestId("delete-skills-line")).toHaveText(
    "Bo만 쓰는 스킬 2개도 함께 삭제돼요.",
  )
  await shot(page, "s54-05-ko-confirm-many")
  await smallShot(
    app,
    page,
    "s54-05-ko-confirm-many-small",
    page.getByTestId("delete-confirm-button"),
  )
  await page.getByTestId("delete-confirm-button").click()
  await expect(archivedRow(page, "Bo")).toHaveCount(0)
  // Only the two skills of Bo went. Cy had none; the skill for all agents and the one of the
  // starter stay.
  expect((await skillsOf(page)).map((s) => s.name)).toEqual(["Check a claim", "Everyone"])
  await closeSettings(page)
  await app.close()
})

test("a starter agent: its skill goes with it, and a copy keeps its own (en)", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1100, 800)

  // Two agents from the same starter get one skill each, the second with a number (spec 002).
  for (let n = 0; n < 2; n++) {
    await page.getByTestId("new-agent").click()
    await page.getByTestId("starter-researcher").click()
    if (n === 1) {
      await page.getByTestId("agent-name").fill("Researcher two")
    }
    await page.getByTestId("agent-submit").click()
    await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
  }
  expect((await skillsOf(page)).map((s) => s.name)).toEqual(["Check a claim", "Check a claim 2"])

  // Delete the first agent: only its own skill goes.
  await archiveFromProfile(page, "Researcher")
  await openArchive(page)
  await askDelete(page, "Researcher")
  await expect(page.getByTestId("delete-skills-line")).toHaveText(
    "1 skill that is only for Researcher is deleted too.",
  )
  await page.getByTestId("delete-confirm-button").click()
  await expect(page.getByTestId("archive-section")).toContainText("No archived agents.")
  expect((await skillsOf(page)).map((s) => s.name)).toEqual(["Check a claim 2"])
  await closeSettings(page)
  await app.close()
})
