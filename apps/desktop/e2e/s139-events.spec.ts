import { expect, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The tab "Events" of the Tasks page (spec 038). One row for each arrival at a place that the
// user made: here a routine on a schedule. The page starts no work.

interface EventInfo {
  id: string
  source: string
  type: string
  summary: string
  result: string
  placeName: string | null
  got: string
  why: string
}

const serverOf = async (page: Parameters<typeof rpc>[0]) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string

const eventsOf = (page: Parameters<typeof rpc>[0]) =>
  serverOf(page).then((serverId) => rpc<EventInfo[]>(page, "events.list", { serverId }))

test("events: the tab shows an arrival, and a test event starts nothing", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // The page opens on the tab "Tasks" and holds the second tab (spec 038, "The page").
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("tasks-page")).toBeVisible()
  await expect(page.getByTestId("tasks-tab")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("events-tab")).toHaveAttribute("aria-selected", "false")
  await shot(page, "s139-01-tasks-tab")

  // A new profile has no event yet.
  await page.getByTestId("events-tab").click()
  await expect(page.getByTestId("events-tab")).toHaveAttribute("aria-selected", "true")
  await expect(page.getByTestId("events-empty")).toBeVisible()
  await shot(page, "s139-02-events-empty")

  // "Check where this goes" records one test event and starts no run (spec 038).
  const serverId = await serverOf(page)
  const before = (await eventsOf(page)).length
  await rpc(page, "events.test", {
    serverId,
    source: "schedule",
    type: "planned run",
    summary: "Planned run of Morning brief",
    why: "Would go to The agent's chat.",
    got: "Summarize yesterday's notes.",
  })
  await expect.poll(async () => (await eventsOf(page)).length, { timeout: 15_000 }).toBe(before + 1)

  const recorded = (await eventsOf(page))[0]
  expect(recorded?.source).toBe("schedule")
  expect(recorded?.result).toBe("would_go")
  expect(recorded?.got).toContain("Summarize yesterday's notes.")

  // The row shows on the tab, with its source and its result.
  await expect(page.getByTestId("events-table")).toContainText("Planned run of Morning brief", {
    timeout: 15_000,
  })
  await expect(page.getByTestId("event-row").first()).toHaveAttribute("data-result", "would_go")
  await shot(page, "s139-03-one-event")

  // The detail shows "Why" and "What the agent got", and it starts no run.
  await page.getByTestId("event-open").first().click()
  await expect(page.getByTestId("event-detail")).toBeVisible()
  await expect(page.getByTestId("event-why")).toContainText("Would go to")
  await expect(page.getByTestId("event-got")).toContainText("Summarize yesterday's notes.")
  await shot(page, "s139-04-event-detail")
  await page.getByTestId("event-close").click()

  // The filter holds the results, and a result with no row says so.
  await page.getByTestId("events-filter-result").selectOption("routed")
  await expect(page.getByTestId("events-no-match")).toBeVisible()
  await shot(page, "s139-05-filter-no-match")
  await page.getByTestId("events-filter-result").selectOption("would_go")
  await expect(page.getByTestId("event-row")).toHaveCount(1)

  // The choice of tab stays after a restart.
  await page.getByTestId("tasks-tab").click()
  await expect(page.getByTestId("tasks-tab")).toHaveAttribute("aria-selected", "true")
  await expect
    .poll(async () => (await rpc<{ tasksTab: string }>(page, "ui.get")).tasksTab, {
      timeout: 15_000,
    })
    .toBe("tasks")
  await page.getByTestId("events-tab").click()
  await expect
    .poll(async () => (await rpc<{ tasksTab: string }>(page, "ui.get")).tasksTab, {
      timeout: 15_000,
    })
    .toBe("events")
  await shot(page, "s139-06-tab-kept")

  await app.close()
  await mock.close()
})
