import { expect, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc, send, settled } from "./sync-helpers.ts"

// The follow-up (spec 005, 007): an agent ends its turn and asks the app to start a new turn
// later, so that it can look at work that takes time. The tool records the follow-up and ends the
// call, so the turn ends as usual. At the time, a new task starts in the same chat.
//
// The stand-in model calls a tool once per "TOOL name {json}" in the message of the user.

interface TaskInfo {
  id: string
  source: string
  state: string
  label: string
}

const serverOf = async (page: Parameters<typeof rpc>[0]) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string

const tasksOf = (page: Parameters<typeof rpc>[0]) =>
  serverOf(page).then((serverId) => rpc<TaskInfo[]>(page, "tasks.list", { serverId }))

test("follow-up: the call ends the turn, and its task starts in the same chat", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // The agent asks to look again in one minute. The call records it and ends: the turn ends and
  // the chat shows the reply, with no wait card.
  await send(page, 'TOOL wait_until {"reason":"CI of the deploy","minutes":1}')
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await shot(page, "s118-01-call-ends-the-turn")

  // The task of the first turn is done, and no follow-up task exists yet.
  const first = await expect
    .poll(async () => (await tasksOf(page)).filter((t) => t.source === "follow_up").length, {
      timeout: 15_000,
    })
    .toBe(0)
  expect(first).toBeUndefined()
  await expect
    .poll(async () => (await tasksOf(page)).filter((t) => t.state === "done").length, {
      timeout: 15_000,
    })
    .toBe(1)

  // The follow-up is due in one minute. It shows in "Next 24 hours" of the Today page.
  await page.getByTestId("page-today").click()
  await expect(page.getByTestId("today-page")).toBeVisible()
  const row = page.locator("[data-testid=today-row][data-kind=followup_next]")
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId("today-line")).toHaveText("CI of the deploy")
  await shot(page, "s118-02-today-next")

  // The time comes: a task with the source "follow-up" starts in the same chat, with the label of
  // the reason. The row leaves the page.
  await expect
    .poll(
      async () => {
        const list = await tasksOf(page)
        const followUp = list.find((t) => t.source === "follow_up")
        return followUp ? `${followUp.state}|${followUp.label}` : "none"
      },
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe("done|Look again: CI of the deploy")
  await expect(row).toHaveCount(0, { timeout: 15_000 })
  await shot(page, "s118-03-follow-up-ran")

  // The task is in the Tasks page with its source label.
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-page")).toBeVisible()
  await expect(page.getByTestId("tasks-table")).toContainText("Look again: CI of the deploy", {
    timeout: 15_000,
  })
  await shot(page, "s118-04-tasks-page")

  await app.close()
  await mock.close()
})

test("follow-up: a channel turn gets the refusal and the turn goes on", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A routine has no direct chat, so its turn has no follow-up (spec 005). The step fails with the
  // reason and the turn ends as done: the call does not end the task.
  const serverId = await serverOf(page)
  const agentId = (
    await rpc<{ id: string; name: string }[]>(page, "agents.list", { serverId, archived: false })
  ).find((a) => a.name === "Ada")?.id as string
  await rpc(page, "routines.create", {
    serverId,
    agentId,
    name: "Nightly",
    prompt: 'TOOL wait_until {"reason":"later","minutes":5}',
    schedule: { kind: "once", at: Date.now() + 3_600_000 },
    place: { kind: "agent" },
  })
  const routine = (
    await rpc<{ id: string; name: string }[]>(page, "routines.list", { serverId })
  ).find((r) => r.name === "Nightly")
  await rpc(page, "routines.runNow", { id: routine?.id })

  // The run ends as done, and no follow-up waits: the tool refused the call.
  await expect
    .poll(async () => (await tasksOf(page)).filter((t) => t.source === "routine").length, {
      timeout: 30_000,
    })
    .toBe(1)
  await expect
    .poll(
      async () =>
        (await tasksOf(page)).filter((t) => t.state === "done" && t.source === "routine").length,
      { timeout: 30_000 },
    )
    .toBe(1)
  expect((await tasksOf(page)).filter((t) => t.source === "follow_up")).toHaveLength(0)

  await app.close()
  await mock.close()
})

test("follow-up: the user deletes it from the task details", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 760, 720)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // Thirty minutes, so the follow-up is still waiting when the user deletes it.
  await send(page, 'TOOL wait_until {"reason":"CI of the deploy","minutes":30}')
  await settled(page)
  await page.getByTestId("page-tasks").click()
  await page.getByTestId("task-open").first().click()
  await expect(page.getByTestId("task-follow-up")).toContainText("CI of the deploy")
  await shot(page, "s118-05-follow-up-in-detail")
  await page.getByTestId("task-follow-up-delete").click()
  await expect(page.getByTestId("task-follow-up-ask")).toHaveText(
    "Delete this? Nothing starts for it.",
  )
  await shot(page, "s118-06-delete-asks")
  await page.getByTestId("task-follow-up-cancel").click()
  await expect(page.getByTestId("task-follow-up")).toBeVisible()

  // The same ask in Korean, then the delete. The row leaves, so no task can start for it.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toBeHidden()
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await page.getByTestId("task-open").first().click()
  await page.getByTestId("task-follow-up-delete").click()
  await expect(page.getByTestId("task-follow-up-ask")).toHaveText(
    "지울까요? 그러면 아무것도 시작되지 않아요.",
  )
  await shot(page, "s118-07-delete-asks-korean")
  await page.getByTestId("task-follow-up-confirm").click()
  await expect(page.getByTestId("task-follow-up")).toHaveCount(0)

  await app.close()
  await mock.close()
})

test("follow-up: the working line says the agent looks again", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 760, 720)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // The follow-up prompt holds the pause above its last line, so the turn stays open long enough
  // to read the working line.
  await send(page, 'TOOL wait_until {"reason":"pause 8000ms","minutes":1}')
  await settled(page)
  await expect(page.getByTestId("working-text")).toHaveText("Looking again…", { timeout: 90_000 })
  await shot(page, "s118-08-looking-again")

  await app.close()
  await mock.close()
})
