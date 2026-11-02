import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 000, 008 and 016: one muted line says that an agent gets better through its instructions,
// memory and knowledge, and through skills that the user saves, and that ROBot does not train the
// model. It shows on the memory page (under the title, above the choice and the tabs) and on the
// knowledge page, also when the list is empty and when the feature is off.

const EN =
  "An agent gets better through its instructions, memory and knowledge, and through skills that you save. ROBot does not train the model."
const KO =
  "에이전트는 지침, 메모리, 지식, 그리고 사용자가 저장한 스킬로 더 나아집니다. ROBot은 모델을 훈련하지 않습니다."

const openProfile = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("memory-panel")).toBeVisible()
}
const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
}
const openKnowledge = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page
    .getByTestId("profile-tabs")
    .getByText(/Knowledge|지식/)
    .click()
  await expect(page.getByTestId("knowledge-page")).toBeVisible()
}
const top = async (page: Page, id: string) => {
  const box = await page.getByTestId(id).boundingBox()
  if (!box) throw new Error(`${id} has no box`)
  return box.y
}

test("honest wording: the memory page shows the line on every tab, empty and with memory off", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1360, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const line = page.getByTestId("memory-honest")

  // The list is empty. The line is the first thing under the title, above the choice and the tabs.
  await openProfile(page)
  await expect(page.getByTestId("memory-item")).toHaveCount(0)
  await expect(line).toHaveText(EN)
  await expect(page.getByTestId("memory-panel").locator(":scope > span").first()).toHaveText(
    "Memory",
  )
  await expect(page.getByTestId("memory-panel").locator(":scope > span").nth(1)).toHaveAttribute(
    "data-testid",
    "memory-honest",
  )
  const title = await page
    .getByTestId("memory-panel")
    .locator(":scope > span")
    .first()
    .boundingBox()
  expect(title).not.toBeNull()
  expect(await top(page, "memory-honest")).toBeGreaterThan(title?.y ?? 0)
  expect(await top(page, "memory-honest")).toBeLessThan(await top(page, "memory-mode"))
  expect(await top(page, "memory-mode")).toBeLessThan(await top(page, "memory-tabs"))
  await shot(page, "s50-01-memory-items")

  // Every tab shows it, also the tab that is empty.
  const tabs = page.getByTestId("memory-tabs")
  await tabs.getByText("History").click()
  await expect(page.getByTestId("memory-history-empty")).toBeVisible()
  await expect(line).toHaveText(EN)
  await page.getByTestId("memory-mode").getByText("Ask me first").click()
  await tabs.getByText("Proposals").click()
  await expect(page.getByTestId("memory-proposals-empty")).toBeVisible()
  await expect(line).toHaveText(EN)
  await shot(page, "s50-02-memory-proposals")
  await tabs.getByText("Items").click()
  await expect(line).toHaveText(EN)

  // Memory off, saved: the page still shows the line.
  await page.getByTestId("agent-memory-enabled").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await openProfile(page)
  await expect(page.getByTestId("agent-memory-enabled")).toHaveAttribute("aria-checked", "false")
  await expect(line).toHaveText(EN)
  await shot(page, "s50-03-memory-off")
  await closeProfile(page)
  await app.close()
  await mock.close()
})

test("honest wording: the knowledge page shows the line when empty and when knowledge is off", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1360, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const line = page.getByTestId("knowledge-honest")

  await openKnowledge(page)
  await expect(page.getByTestId("knowledge-empty")).toContainText("No articles yet.")
  // The empty state does not say that the agent learns.
  await expect(page.getByTestId("knowledge-empty")).toContainText(
    "The agent adds articles as it works. You can add one too.",
  )
  await expect(line).toHaveText(EN)
  // The line is the first one under the title, above the older line and the list.
  await expect(page.getByTestId("knowledge-page").locator(":scope > span").first()).toHaveAttribute(
    "data-testid",
    "knowledge-honest",
  )
  expect(await top(page, "knowledge-honest")).toBeLessThan(await top(page, "knowledge-empty"))
  await shot(page, "s50-04-knowledge-empty")

  // Knowledge off: the muted line "Knowledge is off" shows, and the new line stays.
  await page.getByTestId("knowledge-enabled").click()
  await expect(page.getByTestId("knowledge-off")).toBeVisible()
  await expect(line).toHaveText(EN)
  await shot(page, "s50-05-knowledge-off")
  await app.close()
  await mock.close()
})

test("honest wording: the same line in Korean on both pages", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1360, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  await openProfile(page)
  await expect(page.getByTestId("memory-item")).toHaveCount(0)
  await expect(page.getByTestId("memory-honest")).toHaveText(KO)
  const tabs = page.getByTestId("memory-tabs")
  await tabs.getByText("기록").click()
  await expect(page.getByTestId("memory-honest")).toHaveText(KO)
  await page.getByTestId("memory-mode").getByText("먼저 물어보기").click()
  await tabs.getByText("제안").click()
  await expect(page.getByTestId("memory-honest")).toHaveText(KO)
  await shot(page, "s50-06-memory-ko")
  await closeProfile(page)

  await openKnowledge(page)
  await expect(page.getByTestId("knowledge-honest")).toHaveText(KO)
  await expect(page.getByTestId("knowledge-empty")).toContainText(
    "에이전트는 작업하면서 글을 추가합니다.",
  )
  await page.getByTestId("knowledge-enabled").click()
  await expect(page.getByTestId("knowledge-off")).toBeVisible()
  await expect(page.getByTestId("knowledge-honest")).toHaveText(KO)
  await shot(page, "s50-07-knowledge-ko")
  await app.close()
  await mock.close()
})
