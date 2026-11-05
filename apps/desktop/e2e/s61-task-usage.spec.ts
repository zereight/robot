import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// Usage of a task (specs 005, 009): the tokens of each task, the total of a tree with one line for
// each agent, the cached share, the total on the card of the lead, the total of a run in its run
// details, and the token limit of a routine with its 80 percent line and its failure. The
// stand-in provider reports what the words USAGE in a message say (see `spendOf` in
// mock-provider.ts). The window is 1100 px wide with the activity panel open: the tightest layout.

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)

const serverOf = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const idsOf = async (page: Page) =>
  Object.fromEntries(
    (
      await rpc<{ id: string; name: string }[]>(page, "agents.list", {
        serverId: await serverOf(page),
        archived: false,
      })
    ).map((a) => [a.name, a.id]),
  ) as Record<string, string>

/** Opens the detail of the task row with this label on the Tasks page. */
const openTask = async (page: Page, label: string) => {
  await page.getByTestId("page-tasks").click()
  await page
    .getByTestId("task-row")
    .filter({ has: page.getByTestId("task-open").filter({ hasText: label }) })
    .getByTestId("task-open")
    .click()
  await expect(page.getByTestId("task-detail")).toBeVisible()
}
const closeTask = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toHaveCount(0)
}

interface Words {
  readonly locale: "en-US" | "ko-KR"
  readonly shots: "en" | "ko"
  readonly names: {
    readonly ada: string
    readonly lia: string
    readonly bo: string
    readonly cy: string
  }
  readonly near: string
  readonly limitReached: string
  readonly cachedLabel: string
  readonly line: (input: string, output: string) => string
  readonly leadLine: (input: string, output: string) => string
  readonly silent: string
  readonly share: (percent: number) => string
  readonly week: string
}

const EN: Words = {
  locale: "en-US",
  shots: "en",
  names: { ada: "Ada", lia: "Lia", bo: "Bo", cy: "Cy" },
  near: "80% of the token limit is used.",
  limitReached: "Token limit reached (5000).",
  cachedLabel: "Cached share",
  line: (input, output) => `${input} in · ${output} out`,
  leadLine: (input, output) => `Tokens: ${input} in · ${output} out`,
  silent: "—",
  share: (percent) => `${percent}% of the total`,
  week: "Week",
}
const KO: Words = {
  locale: "ko-KR",
  shots: "ko",
  names: { ada: "에이다", lia: "리아", bo: "보", cy: "시" },
  near: "토큰 한도의 80%를 사용했어요.",
  limitReached: "토큰 한도(5000)에 도달했어요.",
  cachedLabel: "캐시 비율",
  line: (input, output) => `입력 ${input} · 출력 ${output}`,
  leadLine: (input, output) => `토큰: 입력 ${input} · 출력 ${output}`,
  silent: "—",
  share: (percent) => `전체의 ${percent}%`,
  week: "주",
}

const scenario = (words: Words) => async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: words.locale })
  await resizeWindow(app, 1100, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  // The members of the plan must be named Bo and Cy for the stand-in lead (see mock-provider.ts).
  for (const name of [words.names.ada, words.names.lia, "Bo", "Cy"]) await createAgent(page, name)

  // ---- a chat task: tokens, and the cached share only when the provider reports cached input ----
  await send(page, "cached reply USAGE 8000/100/6000")
  await settled(page)
  await send(page, "plain reply USAGE 1000/200")
  await settled(page)
  await send(page, "silent reply USAGE none")
  await settled(page)

  await openTask(page, "cached reply USAGE 8000/100/6000")
  await expect(page.getByTestId("task-usage-input")).toHaveText("8,000")
  await expect(page.getByTestId("task-usage-output")).toHaveText("100")
  await expect(page.getByTestId("task-usage-cached")).toHaveText("75%")
  await expect(page.getByTestId("task-usage")).toContainText(words.cachedLabel)
  // The task has no child task: no total of a tree.
  await expect(page.getByTestId("task-tree-numbers")).toHaveCount(0)
  await shot(page, `s61-01-cached-${words.shots}`)
  await closeTask(page)

  await openTask(page, "plain reply USAGE 1000/200")
  await expect(page.getByTestId("task-usage-input")).toHaveText("1,000")
  await expect(page.getByTestId("task-usage-output")).toHaveText("200")
  // The provider reports no cached input: the app shows no cached share.
  await expect(page.getByTestId("task-usage-cached")).toHaveCount(0)
  await closeTask(page)

  // A provider that reports nothing: the numbers are "—", never 0.
  await openTask(page, "silent reply USAGE none")
  await expect(page.getByTestId("task-usage-input")).toHaveText("—")
  await expect(page.getByTestId("task-usage-output")).toHaveText("—")
  await expect(page.getByTestId("task-usage-cached")).toHaveCount(0)
  await closeTask(page)

  // ---- a channel job: the card of the lead while it runs, then the tree with a line for each agent ----
  const ids = await idsOf(page)
  await rpc(page, "channels.create", {
    serverId: await serverOf(page),
    name: "Launch",
    topic: "",
    memberIds: [ids[words.names.lia], ids.Bo, ids.Cy],
    leadId: ids[words.names.lia],
  })
  await page.getByTestId("page-chats").click()
  await page.locator('[data-place-row][data-place-name="Launch"]').click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")
  await expect(page.getByTestId("activity-panel")).toBeVisible()
  await page.getByTestId("channel-input").fill("split usage job USAGE 1000/200")
  await page.getByTestId("channel-input").press("Enter")
  // Bo has answered; Cy is quiet. The lead reported 1000/200 and Bo 3000/500: the card of the lead
  // holds the total of the job that runs.
  const leadCard = page.getByTestId("lead-usage")
  await expect(leadCard).toHaveText(words.leadLine("4,000", "700"), { timeout: 30_000 })
  await expect(leadCard).toHaveAttribute("data-input", "4000")
  await expect(leadCard).toHaveAttribute("data-output", "700")
  await shot(page, `s61-02-lead-card-${words.shots}`)

  // Cy goes on, and the job ends with the totals of all three agents.
  mock.releaseQuiet()
  await expect(page.locator("[data-kind=summary]")).toHaveCount(1, { timeout: 30_000 })
  await openTask(page, "split usage job USAGE 1000/200")
  await expect(page.getByTestId("task-tree-input")).toHaveText("7,000")
  await expect(page.getByTestId("task-tree-output")).toHaveText("1,200")
  const lines = page.getByTestId("task-tree-line")
  await expect(lines).toHaveCount(3)
  // The largest total first; two with the same total go by name.
  await expect(lines.nth(0)).toHaveAttribute("data-agent", "Bo")
  await expect(lines.nth(1)).toHaveAttribute("data-agent", "Cy")
  await expect(lines.nth(2)).toHaveAttribute("data-agent", words.names.lia)
  await expect(lines.nth(0).getByTestId("task-tree-line-numbers")).toHaveText(
    words.line("3,000", "500"),
  )
  await expect(lines.nth(0).getByTestId("task-tree-line-share")).toHaveText(
    words.share(percentOf(3500, 8200)),
  )
  await expect(lines.nth(2).getByTestId("task-tree-line-numbers")).toHaveText(
    words.line("1,000", "200"),
  )
  await shot(page, `s61-03-tree-${words.shots}`)
  await closeTask(page)

  // A third member that reports nothing: its line shows "—", and the total counts the others.
  await page.locator('[data-place-row][data-place-name="Launch"]').click()
  await page.getByTestId("channel-input").fill("split usagegap job USAGE 1000/200")
  await page.getByTestId("channel-input").press("Enter")
  await expect(page.locator("[data-kind=summary]")).toHaveCount(2, { timeout: 30_000 })
  await openTask(page, "split usagegap job USAGE 1000/200")
  await expect(page.getByTestId("task-tree-input")).toHaveText("4,000")
  await expect(page.getByTestId("task-tree-output")).toHaveText("700")
  await expect(page.locator('[data-testid=task-tree-line][data-agent="Cy"]')).toHaveCount(1)
  await expect(
    page
      .locator('[data-testid=task-tree-line][data-agent="Cy"]')
      .getByTestId("task-tree-line-none"),
  ).toHaveText(words.silent)
  // It is the last line.
  await expect(page.getByTestId("task-tree-line").last()).toHaveAttribute("data-agent", "Cy")
  await shot(page, `s61-04-tree-gap-${words.shots}`)
  await closeTask(page)

  // ---- a routine with a token limit ----
  await page.getByTestId("page-routines").click()
  await expect(page.getByTestId("routines-view")).toBeVisible()
  await page.getByTestId("routine-new").click()
  await page.getByTestId("routine-name").fill("Folder check")
  await page.getByTestId("routine-agent").selectOption({ label: words.names.ada })
  await page
    .getByTestId("routine-prompt")
    .fill("check the folder TOOL list_files {} HOLDAFTER USAGE 4100,1100")
  // A value out of range is refused in the form.
  await page.getByTestId("routine-token-limit").fill("999")
  await expect(page.getByTestId("routine-token-limit-error")).toBeVisible()
  await expect(page.getByTestId("routine-save")).toBeDisabled()
  await shot(page, `s61-05-limit-error-${words.shots}`)
  await page.getByTestId("routine-token-limit").fill("5000")
  await expect(page.getByTestId("routine-token-limit-error")).toHaveCount(0)
  await expect(page.getByTestId("routine-token-limit-hint")).toBeVisible()
  await shot(page, `s61-06-limit-form-${words.shots}`)
  await page.getByTestId("routine-save").click()
  await expect(page.getByTestId("routine-dialog")).toHaveCount(0)
  await expect(page.getByTestId("routine-limit-line")).toContainText("5,000")

  // Run now: the first request reports 4100 tokens, then the model waits. The run details show the
  // total and the line at 80 percent; the run goes on.
  const routine = (
    await rpc<{ id: string }[]>(page, "routines.list", { serverId: await serverOf(page) })
  )[0]
  await rpc(page, "routines.runNow", { id: routine?.id })
  await page.getByTestId("routine-view").getByText(words.week, { exact: true }).click()
  const entry = page.locator("[data-testid=calendar-entry][data-state=running]")
  await expect(entry).toHaveCount(1, { timeout: 30_000 })
  await expect(entry.getByTestId("calendar-limit-near")).toHaveText(words.near, { timeout: 30_000 })
  await expect(entry.getByTestId("calendar-run-tokens")).toHaveAttribute("data-input", "4090")
  await shot(page, `s61-07-run-near-${words.shots}`)

  // The next request reports 1100 more: 5200 in all, over the limit. The run stops and fails.
  mock.releaseQuiet()
  const failed = page.locator("[data-testid=calendar-entry][data-state=failed]")
  await expect(failed).toHaveCount(1, { timeout: 30_000 })
  await expect(failed.getByTestId("calendar-reason")).toContainText(words.limitReached)
  await expect(failed.getByTestId("calendar-run-tokens")).toHaveAttribute("data-input", /^5\d{3}$/)
  await shot(page, `s61-08-run-failed-${words.shots}`)

  // The task of the run failed with the same reason.
  await openTask(page, "check the folder")
  await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "failed")
  await expect(page.getByTestId("task-error")).toContainText(words.limitReached)
  await closeTask(page)

  await app.close()
  await mock.close()
}

/** The share of an agent in percent, as the app rounds it. */
const percentOf = (part: number, whole: number) => Math.round((part / whole) * 100)

test(
  "usage of a task: tokens, the cached share, the tree, the card of the lead and the token limit (English)",
  scenario(EN),
)
test("usage of a task: the same in Korean", scenario(KO))
