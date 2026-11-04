import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The limits of routines (spec 009): at most 50 routines, a note for a schedule that runs more
// than once in 15 minutes, and the pause after 3 failed runs in a row, with one notification.

const HOUR = 3_600_000
const LIMIT = 50

const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const agentOf = async (page: Page, name: string) =>
  (
    await rpc<{ id: string; name: string }[]>(page, "agents.list", {
      serverId: await serverOf(page),
      archived: false,
    })
  ).find((a) => a.name === name)?.id as string

const makeRoutine = async (page: Page, agentId: string, name: string, prompt: string) =>
  rpc<{ id: string }>(page, "routines.create", {
    serverId: await serverOf(page),
    agentId,
    name,
    prompt,
    schedule: { kind: "once", at: Date.now() + 3 * HOUR },
    place: { kind: "agent" },
  })

const blockedRuns = async (page: Page) =>
  (
    await rpc<{ state: string; source: string }[]>(page, "tasks.list", {
      serverId: await serverOf(page),
    })
  ).filter((t) => t.source === "routine" && t.state === "blocked").length

const noticesOf = (log: string) => () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { title: string; body: string })
    : []

interface Words {
  readonly locale: "en-US" | "ko-KR"
  readonly agent: string
  readonly paused: string
  readonly pausedNotice: string
  readonly full: string
  readonly often: string
  readonly shots: string
}

const EN: Words = {
  locale: "en-US",
  agent: "Ada",
  paused: "Paused after 3 failed runs",
  pausedNotice: "Weekly report is paused after 3 failed runs.",
  full: "This server has 50 routines, the most it can hold. A paused routine counts. Delete one to make another.",
  often: "This runs about 288 times a day.",
  shots: "en",
}
const KO: Words = {
  locale: "ko-KR",
  agent: "에이다",
  paused: "3번 연속 실패해서 일시 중지됨",
  pausedNotice: "주간 보고이(가) 3번 연속 실패해서 일시 중지됐어요.",
  full: "이 서버에는 루틴이 이미 50개 있어서 더 만들 수 없어요. 일시 중지된 루틴도 개수에 들어가요. 하나를 지우면 새로 만들 수 있어요.",
  often: "하루에 약 288번 실행돼요.",
  shots: "ko",
}

const scenario = (words: Words, reportName: string) => async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const log = join(userData, "notices.jsonl")
  const notices = noticesOf(log)
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: words.locale,
    ROBOT_TEST_NOTIFY_LOG: log,
    ROBOT_TEST_UNFOCUSED: "1",
  })
  // Under 800 px wide is the narrow layout of spec 001: the rail is 56 px and the panel is closed.
  await resizeWindow(app, 760, 760)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, words.agent)
  const agentId = await agentOf(page, words.agent)
  await page.getByTestId("page-workflows").click()
  await expect(page.getByTestId("routines-view")).toBeVisible()

  // A routine whose agent says "Blocked" in 3 runs in a row: each failed run has its notice, and
  // the third run has the one notice that says the routine is paused.
  const report = await makeRoutine(page, agentId, reportName, "BLOCKEDPART check the folder")
  await expect(page.getByTestId("routine-card")).toHaveCount(1)
  for (const n of [1, 2]) {
    await rpc(page, "routines.runNow", { id: report.id })
    await expect.poll(() => blockedRuns(page), { timeout: 30_000 }).toBe(n)
    await expect.poll(() => notices().length, { timeout: 10_000 }).toBe(n)
    await expect(page.getByTestId("routine-paused")).toHaveCount(0)
  }
  await rpc(page, "routines.runNow", { id: report.id })
  await expect.poll(() => blockedRuns(page), { timeout: 30_000 }).toBe(3)
  await expect(page.getByTestId("routine-paused")).toContainText(words.paused, { timeout: 10_000 })
  await expect(page.getByTestId("routine-card")).toHaveAttribute("data-enabled", "false")
  await expect.poll(() => notices().length, { timeout: 10_000 }).toBe(3)
  expect(notices()[2]).toMatchObject({ title: words.agent, body: words.pausedNotice })
  expect(notices().filter((n) => n.body === words.pausedNotice)).toHaveLength(1)
  await shot(page, `s29-01-paused-${words.shots}`)

  // Resume clears the paused text and the count of failed runs. No fourth run and no new notice.
  await page.getByTestId("routine-enabled").click()
  await expect(page.getByTestId("routine-paused")).toHaveCount(0)
  await expect(page.getByTestId("routine-card")).toHaveAttribute("data-enabled", "true")
  expect(await blockedRuns(page)).toBe(3)
  expect(notices()).toHaveLength(3)
  await page.getByTestId("routine-delete").click()
  await expect(page.getByTestId("routine-card")).toHaveCount(0)

  // 50 routines: the form for one more says why it cannot save. The main process refuses too.
  for (let i = 0; i < LIMIT; i++) await makeRoutine(page, agentId, `R${i}`, "Look at it.")
  await expect(page.getByTestId("routine-card")).toHaveCount(LIMIT)
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("One more")
  await page.getByTestId("routine-prompt").fill("Look at it.")
  await expect(page.getByTestId("routine-full")).toHaveText(words.full)
  await expect(page.getByTestId("routine-save")).toBeDisabled()
  await shot(page, `s29-02-full-${words.shots}`)
  await expect(
    rpc(page, "routines.create", {
      serverId: await serverOf(page),
      agentId,
      name: "One more",
      prompt: "Look at it.",
      schedule: { kind: "daily", times: ["09:00"] },
      place: { kind: "agent" },
    }),
  ).rejects.toThrow("routines_full")
  await expect(page.getByTestId("routine-card")).toHaveCount(LIMIT)
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("routine-dialog")).toHaveCount(0)

  // Delete one: the form saves. A schedule of every 5 minutes shows its note, and saves.
  await page.getByTestId("routine-delete").first().click()
  await expect(page.getByTestId("routine-card")).toHaveCount(LIMIT - 1)
  await page.getByTestId("routine-new").click()
  await expect(page.getByTestId("routine-full")).toHaveCount(0)
  await page.getByTestId("routine-name").fill("Often")
  await page.getByTestId("routine-prompt").fill("Look at it.")
  await page.getByTestId("routine-kind").selectOption("every")
  await page.getByTestId("routine-minutes").fill("30")
  await expect(page.getByTestId("routine-often")).toHaveCount(0)
  await page.getByTestId("routine-minutes").fill("5")
  await expect(page.getByTestId("routine-often")).toHaveText(words.often)
  await expect(page.getByTestId("routine-preview").locator("li")).toHaveCount(3)
  // The form scrolls. The note is under the next run times, so the user scrolls to it.
  await page.getByTestId("routine-often").scrollIntoViewIfNeeded()
  await shot(page, `s29-03-often-${words.shots}`)
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-dialog")).toHaveCount(0)
  await expect(page.getByTestId("routine-card")).toHaveCount(LIMIT)

  // The 51st again: the form says "full" at once.
  await page.getByTestId("routine-new").click()
  await expect(page.getByTestId("routine-full")).toBeVisible()
  await page.keyboard.press("Escape")

  await app.close()
  await mock.close()
}

test(
  "routine limits (English): pause after 3 failed runs with one notice, 50 routines, the note of a short schedule",
  scenario(EN, "Weekly report"),
)
test("routine limits (Korean): the same states in Korean", scenario(KO, "주간 보고"))
