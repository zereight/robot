import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// S67: the team file (spec 002, "Agent file"; spec 014, "Review before an import"; spec 017). The
// export dialog has two tick boxes (skills and the handbook). The file is format version 2. The
// review screen of the import lists the skills and the handbook, and the import makes them by the
// rules. ROBot has no channels: the channels of a file show under "Not imported". The scenario runs in English and in Korean, at 1100 px wide
// with the activity panel open (the chat column is about 460 px then).

interface Words {
  readonly locale: "en-US" | "ko-KR"
  readonly shots: "en" | "ko"
  readonly exportSkills: string
  readonly exportHandbook: string
  readonly found: (n: number) => string
  readonly handbookLength: (n: number) => string
  readonly showAll: string
  readonly replaces: string
  readonly channel: (name: string) => string
  readonly channelGone: string
  readonly noAgent: string
  readonly secret: string
  readonly saved: (path: string) => string
  readonly savedHandbook: string
  readonly countsStart: string
  readonly countsWithHandbook: string
  readonly countsHandbook: string
  readonly nothing: string
  readonly imported: string
  readonly handbookReplaced: string
  readonly v1Counts: string
}
const EN: Words = {
  locale: "en-US",
  shots: "en",
  exportSkills: "Skills of these agents",
  exportHandbook: "Handbook",
  found: (n) => `${n} found`,
  handbookLength: (n) => `${n} characters`,
  showAll: "Show all",
  replaces: "Replaces the handbook of this server. The old text stays in the handbook history.",
  channel: (name) => `Channel “${name}”`,
  channelGone: "ROBot has no channels.",
  noAgent: "None of the agents that may use it is ticked.",
  secret: "A secret was removed",
  saved: (path) => `Saved 2 agents and 2 skills to ${path}`,
  savedHandbook: "The file holds the handbook.",
  countsStart: "ROBot will make 2 agents, 0 routines (paused) and 2 skills (off).",
  countsWithHandbook:
    "ROBot will make 2 agents, 0 routines (paused) and 2 skills (off). It will replace the handbook.",
  countsHandbook: "ROBot will replace the handbook.",
  nothing: "Nothing is ticked.",
  imported: "Imported 2 agents, 0 routines (paused) and 2 skills (off).",
  handbookReplaced: "The handbook was replaced.",
  v1Counts: "ROBot will make 1 agents, 0 routines (paused).",
}
const KO: Words = {
  locale: "ko-KR",
  shots: "ko",
  exportSkills: "이 에이전트들의 스킬",
  exportHandbook: "핸드북",
  found: (n) => `${n}개`,
  handbookLength: (n) => `${n}자`,
  showAll: "모두 보기",
  replaces: "이 서버의 핸드북을 바꿔요. 이전 글은 핸드북 기록에 남아요.",
  channel: (name) => `채널 “${name}”`,
  channelGone: "ROBot에는 채널이 없어요.",
  noAgent: "쓸 수 있는 에이전트가 아무도 체크되지 않았어요.",
  secret: "비밀 값이 지워졌어요",
  saved: (path) => `에이전트 2개, 스킬 2개를 ${path}에 저장했어요.`,
  savedHandbook: "파일에 핸드북이 들어 있어요.",
  countsStart: "에이전트 2개, 루틴 0개(멈춤), 스킬 2개(꺼짐)를 만들어요.",
  countsWithHandbook: "에이전트 2개, 루틴 0개(멈춤), 스킬 2개(꺼짐)를 만들어요. 핸드북도 바꿔요.",
  countsHandbook: "핸드북을 바꿔요.",
  nothing: "체크한 항목이 없어요.",
  imported: "에이전트 2개, 루틴 0개(멈춤), 스킬 2개(꺼짐)를 가져왔어요.",
  handbookReplaced: "핸드북을 바꿨어요.",
  v1Counts: "에이전트 1개, 루틴 0개(멈춤)를 만들어요.",
}

const HANDBOOK = [
  "We write in short, plain sentences.",
  "Answer in the language of the user.",
  "Name the risk before the plan.",
  "Keep each answer under ten lines.",
  "Cite a source for each claim.",
  "Ask before you delete a file.",
].join("\n")
const LOOKALIKE = "sk-looks-like-a-key-0123456789abcdef"

type Agent = { id: string; name: string }
type Skill = { name: string; enabled: boolean; agentIds: string[] | null; description: string }

const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const agentsOf = async (page: Page) =>
  rpc<Agent[]>(page, "agents.list", { serverId: await serverOf(page), archived: false })
const channelsOf = async (page: Page) =>
  rpc<{ name: string }[]>(page, "channels.list", { serverId: await serverOf(page) })
const skillsOf = async (page: Page) =>
  rpc<Skill[]>(page, "skills.list", { serverId: await serverOf(page) })

const openExport = async (page: Page) => {
  await page.getByTestId("agents-menu").click()
  await page.getByTestId("agents-menu-export").click()
  await expect(page.getByTestId("agent-export-dialog")).toBeVisible()
}
const openImport = async (page: Page) => {
  await page.getByTestId("agents-menu").click()
  await page.getByTestId("agents-menu-import-file").click()
}

/** The app window must keep the chat column at about 460 px: the activity panel is open. */
const checkWindow = async (page: Page) => {
  await expect(page.getByTestId("activity-panel")).toBeVisible()
  const width = await page.evaluate(() => window.innerWidth)
  expect(width).toBeGreaterThanOrEqual(1090)
  expect(width).toBeLessThanOrEqual(1110)
}

/** The dialog must fit the window: no part of it is cut at the side. */
const fits = async (page: Page, testId: string) => {
  const box = await page.getByTestId(testId).boundingBox()
  const width = await page.evaluate(() => window.innerWidth)
  expect(box).not.toBeNull()
  expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= width).toBe(true)
}

const scenario = (words: Words) => async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s67-"))
  const teamFile = join(work, "team.json")
  const v1File = join(work, "v1.json")
  const secretFile = join(work, "secret.json")
  const env = { ROBOT_SYSTEM_LOCALE: words.locale }
  const tag = words.shots

  // ---- app one: the data, and the export -------------------------------------------------------
  let { app, page } = await launch(freshUserData(), {
    ...env,
    ROBOT_TEST_AGENT_FILE_SAVE: teamFile,
  })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await checkWindow(page)
  for (const name of ["Ada", "Bob", "Cy"]) await createAgent(page, name)
  const serverId = await serverOf(page)
  const made = await agentsOf(page)
  const idFor = (name: string) => made.find((a) => a.name === name)?.id as string
  const ids = { ada: idFor("Ada"), bob: idFor("Bob"), cy: idFor("Cy") }

  const skill = (name: string, agentIds: string[] | null) =>
    rpc(page, "skills.create", {
      serverId,
      name,
      description: `${name} help`,
      instructions: `Do the ${name} steps.`,
      agentIds,
    })
  await skill("Summarise", null)
  await skill("Review notes", [ids.ada])
  await skill("Cy only", [ids.cy])
  await rpc(page, "handbook.save", { serverId, text: HANDBOOK })

  // The two tick boxes are off at the start. They show how many skills the file would hold for
  // the agents that are picked now. There is no tick box for channels.
  await openExport(page)
  const dialog = page.getByTestId("agent-export-dialog")
  await expect(dialog.getByTestId("agent-export-item")).toHaveCount(3)
  await expect(dialog.getByTestId("agent-export-channels")).toHaveCount(0)
  for (const box of ["skills", "handbook"])
    await expect(dialog.getByTestId(`agent-export-${box}`)).not.toBeChecked()
  await expect(dialog.getByTestId("agent-export-team")).toContainText(words.exportSkills)
  await expect(dialog.getByTestId("agent-export-team")).toContainText(words.exportHandbook)
  await expect(dialog.getByTestId("agent-export-skills-count")).toHaveText(words.found(3))
  await fits(page, "agent-export-dialog")
  await shot(page, `s67-${tag}-01-export-start`)

  // Cy is not picked: the skill of Cy leaves the count.
  await dialog.getByTestId("agent-export-item").nth(2).uncheck()
  await expect(dialog.getByTestId("agent-export-skills-count")).toHaveText(words.found(2))
  for (const box of ["skills", "handbook"]) await dialog.getByTestId(`agent-export-${box}`).check()
  await shot(page, `s67-${tag}-02-export-ticked`)
  await dialog.getByTestId("agent-export-submit").click()
  await expect(dialog.getByTestId("agent-export-saved")).toContainText(words.saved(teamFile))
  await expect(dialog.getByTestId("agent-export-saved")).toContainText(words.savedHandbook)
  await shot(page, `s67-${tag}-03-export-saved`)
  await dialog.getByTestId("agent-export-close").click()
  await expect(page.getByTestId("agent-export-dialog")).toHaveCount(0)

  // The file: format version 2, with no channels, the skills that Ada or Bob may use (a skill for
  // all agents is written for them), and the handbook.
  const written = JSON.parse(readFileSync(teamFile, "utf8")) as {
    version: number
    agents: { name: string }[]
    skills: { name: string; agents: string[] }[]
    handbook: string
  }
  expect(written.version).toBe(2)
  expect(written.agents.map((a) => a.name)).toEqual(["Ada", "Bob"])
  expect(written).not.toHaveProperty("channels")
  expect(written.skills.map((k) => [k.name, k.agents])).toEqual([
    ["Review notes", ["Ada"]],
    ["Summarise", ["Ada", "Bob"]],
  ])
  expect(written.handbook).toBe(HANDBOOK)

  await app.close()

  // Two files are made by hand for the checks below: version 1 with fields that it does not
  // define, and version 2 with a channel and with a key in the handbook.
  writeFileSync(
    secretFile,
    JSON.stringify({
      format: "robot-agents",
      version: 2,
      agents: [{ name: "Ada" }],
      channels: [{ name: "Ops", instructions: `Use ${LOOKALIKE}.`, members: ["Ada"] }],
      skills: [{ name: "Plain", instructions: "Do it.", agents: ["Ada"] }],
      handbook: `The key is ${LOOKALIKE}.`,
    }),
  )
  writeFileSync(
    v1File,
    JSON.stringify({
      format: "robot-agents",
      version: 1,
      agents: [{ name: "Old" }],
      channels: [{ name: "Ignored", members: ["Old"] }],
      handbook: "Ignored",
    }),
  )

  // ---- app two: it has an agent and a handbook of its own --------------------------------------
  ;({ app, page } = await launch(freshUserData(), { ...env, ROBOT_TEST_AGENT_FILE_OPEN: teamFile }))
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await checkWindow(page)
  await createAgent(page, "Zed")
  const target = await serverOf(page)
  await rpc(page, "handbook.save", { serverId: target, text: "The old handbook." })

  await openImport(page)
  const review = page.getByTestId("agent-import-dialog")
  await expect(review.getByTestId("agent-import-item")).toHaveCount(2)
  // Skills start ticked; the handbook does not.
  await expect(review.getByTestId("skill-import-item")).toHaveCount(2)
  for (const tick of await review.getByTestId("skill-import-tick").all())
    await expect(tick).toBeChecked()
  await expect(review.getByTestId("handbook-import-tick")).not.toBeChecked()
  await expect(review.getByTestId("skill-import-agents").first()).toContainText("Ada")
  // The handbook shows its first lines and "Show all", and says that it replaces the handbook.
  await expect(review.getByTestId("handbook-import")).toContainText(
    words.handbookLength([...HANDBOOK].length),
  )
  await expect(review.getByTestId("handbook-import-replaces")).toHaveText(words.replaces)
  await expect(review.getByTestId("handbook-import-text")).not.toContainText(
    "Ask before you delete",
  )
  await expect(review.getByTestId("handbook-import-show-all")).toHaveText(words.showAll)
  await expect(review.getByTestId("agent-import-counts")).toHaveText(words.countsStart)
  await fits(page, "agent-import-dialog")
  await shot(page, `s67-${tag}-05-review-start`)

  await review.getByTestId("handbook-import-show-all").click()
  await expect(review.getByTestId("handbook-import-text")).toContainText("Ask before you delete")
  await review.getByTestId("handbook-import-text").scrollIntoViewIfNeeded()
  await shot(page, `s67-${tag}-06-review-handbook-open`)

  // Ada is not ticked: the skill "Review notes" needs Ada only and has no agent left. "Not
  // imported" says so, at once.
  await review.getByTestId("agent-import-tick").first().uncheck()
  const notImported = review.getByTestId("agent-import-not-imported")
  await expect(notImported).toContainText("Review notes")
  await expect(notImported).toContainText(words.noAgent)
  // Bob is not ticked too: now nothing is ticked.
  await review.getByTestId("agent-import-tick").nth(1).uncheck()
  await expect(review.getByTestId("agent-import-submit")).toBeDisabled()
  await expect(review.getByTestId("agent-import-counts")).toHaveText(words.nothing)
  await review.getByTestId("agent-import-not-imported").scrollIntoViewIfNeeded()
  await shot(page, `s67-${tag}-07-review-not-imported`)
  // The handbook alone is enough to import.
  await review.getByTestId("handbook-import-tick").check()
  await expect(review.getByTestId("agent-import-counts")).toHaveText(words.countsHandbook)
  await expect(review.getByTestId("agent-import-submit")).toBeEnabled()
  await review.getByTestId("handbook-import-tick").uncheck()
  await expect(review.getByTestId("agent-import-submit")).toBeDisabled()

  // Tick everything back, and the handbook, and pick a model.
  await review.getByTestId("agent-import-tick").first().check()
  await review.getByTestId("agent-import-tick").nth(1).check()
  await review.getByTestId("handbook-import-tick").check()
  await review.getByTestId("model-model").selectOption("o3-mini")
  await expect(review.getByTestId("agent-import-counts")).toHaveText(words.countsWithHandbook)
  await review.getByTestId("agent-import-submit").click()
  await expect(page.getByTestId("agent-import-dialog")).toHaveCount(0)

  // The result: a line says what was made. The agents and the skills are there.
  await expect(page.getByTestId("toasts")).toContainText(words.imported)
  await expect(page.getByTestId("toasts")).toContainText(words.handbookReplaced)
  await shot(page, `s67-${tag}-08-import-result`)
  const agents = await agentsOf(page)
  expect(agents.map((a) => a.name).sort()).toEqual(["Ada", "Bob", "Zed"])
  expect(await channelsOf(page)).toEqual([])
  const idOf = (name: string) => agents.find((a) => a.name === name)?.id
  // The skills are off, and each one is for the agents that were made.
  const skills = await skillsOf(page)
  expect(skills.map((k) => [k.name, k.enabled]).sort()).toEqual([
    ["Review notes", false],
    ["Summarise", false],
  ])
  expect(skills.find((k) => k.name === "Summarise")?.agentIds?.sort()).toEqual(
    [idOf("Ada"), idOf("Bob")].sort(),
  )
  // The handbook is the text of the file, and the old text is in its history.
  const handbook = await rpc<{ text: string }>(page, "handbook.get", { serverId: target })
  expect(handbook.text).toBe(HANDBOOK)
  const history = await rpc<{ text: string; source: string }[]>(page, "handbook.history", {
    serverId: target,
  })
  expect(history.map((v) => [v.text, v.source])).toEqual([
    [HANDBOOK, "import"],
    ["The old handbook.", "page"],
  ])

  // Where the user sees it: the Skills page shows the new skills off; the Handbook page shows
  // the text and the history with the source "Import".
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-skills").click()
  await expect(page.locator("[data-testid=skill-row]")).toHaveCount(2)
  await shot(page, `s67-${tag}-09-skills-page`)
  await page.getByTestId("settings-nav-handbook").click()
  await expect(page.getByTestId("handbook-section")).toBeVisible()
  await expect(page.getByTestId("handbook-version-source").first()).toBeVisible()
  await shot(page, `s67-${tag}-10-handbook-page`)
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toBeHidden()
  await app.close()

  // ---- app three: a key in a part marks it and leaves it not ticked; the handbook stays when it
  // is not ticked; the channel of the file is not imported ---------------------------------------
  ;({ app, page } = await launch(freshUserData(), {
    ...env,
    ROBOT_TEST_AGENT_FILE_OPEN: secretFile,
  }))
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  const third = await serverOf(page)
  await rpc(page, "handbook.save", { serverId: third, text: "Mine." })
  await openImport(page)
  const plain = page.getByTestId("agent-import-dialog")
  await expect(plain.getByTestId("channel-import-item")).toHaveCount(0)
  await expect(plain.getByTestId("agent-import-not-imported")).toContainText(words.channel("Ops"))
  await expect(plain.getByTestId("agent-import-not-imported")).toContainText(words.channelGone)
  await expect(plain.getByTestId("skill-import-tick")).toBeChecked()
  await expect(plain.getByTestId("handbook-import-tick")).not.toBeChecked()
  await expect(plain.getByTestId("handbook-import").getByTestId("import-secret")).toHaveText(
    words.secret,
  )
  await expect(plain.getByTestId("handbook-import-text")).not.toContainText(LOOKALIKE)
  await expect(plain.getByTestId("handbook-import-text")).toContainText("[redacted]")
  await shot(page, `s67-${tag}-12-review-secret`)
  await plain.getByTestId("model-model").selectOption("o3-mini")
  await plain.getByTestId("agent-import-submit").click()
  await expect(page.getByTestId("agent-import-dialog")).toHaveCount(0)
  expect((await rpc<{ text: string }>(page, "handbook.get", { serverId: third })).text).toBe(
    "Mine.",
  )
  expect(await channelsOf(page)).toEqual([])
  expect((await skillsOf(page)).map((k) => [k.name, k.enabled])).toEqual([["Plain", false]])
  await app.close()

  ;({ app, page } = await launch(freshUserData(), { ...env, ROBOT_TEST_AGENT_FILE_OPEN: v1File }))
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await openImport(page)
  const old = page.getByTestId("agent-import-dialog")
  await expect(old.getByTestId("agent-import-item")).toHaveCount(1)
  await expect(old.getByTestId("channel-import")).toHaveCount(0)
  await expect(old.getByTestId("skill-import")).toHaveCount(0)
  await expect(old.getByTestId("handbook-import")).toHaveCount(0)
  // The fields of version 2 are not defined in version 1: they show under "Not imported".
  await expect(old.getByTestId("agent-import-not-imported")).toContainText("channels")
  await expect(old.getByTestId("agent-import-not-imported")).toContainText("handbook")
  await expect(old.getByTestId("agent-import-counts")).toHaveText(words.v1Counts)
  await shot(page, `s67-${tag}-11-review-version-1`)
  await old.getByTestId("model-model").selectOption("o3-mini")
  await old.getByTestId("agent-import-submit").click()
  await expect(page.getByTestId("agent-import-dialog")).toHaveCount(0)
  expect((await agentsOf(page)).map((a) => a.name)).toEqual(["Old"])
  expect(await channelsOf(page)).toEqual([])
  await app.close()
}

test("team file: the tick boxes, the review and the import (English)", scenario(EN))
test("team file: the tick boxes, the review and the import (Korean)", scenario(KO))
