import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

test("tools: approval cards, deny, question, stop, permission level, memory", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const outside = join(userData, "outside")
  mkdirSync(outside, { recursive: true })
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A risky step waits for approval; nothing happens until the user answers.
  const keep = join(outside, "keep.txt")
  writeFileSync(keep, "x")
  await send(page, `TOOL run_command ${JSON.stringify({ command: `rm "${keep}"` })}`)
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  expect(existsSync(keep)).toBe(true)
  await shot(page, "s10-01-approval")
  await page.getByTestId("ask-deny").click()
  await settled(page)
  expect(existsSync(keep)).toBe(true)
  await expect(page.getByTestId("tool-card").first()).toContainText("Failed")

  // Allow once runs it.
  await send(page, `TOOL run_command ${JSON.stringify({ command: `rm "${keep}"` })}`)
  await page.getByTestId("ask-allow").click()
  await settled(page)
  await expect.poll(() => existsSync(keep)).toBe(false)

  // A question card takes a typed answer, which goes to the model.
  await send(page, `TOOL ask_user ${JSON.stringify({ question: "Which colour?" })}`)
  await expect(page.getByTestId("ask-card")).toContainText("Which colour?", { timeout: 15_000 })
  await shot(page, "s10-02-question")
  await page.getByTestId("ask-input").fill("green")
  await page.getByTestId("ask-send").click()
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Tool said: green")

  // Stop while a card waits.
  await send(page, `TOOL run_command ${JSON.stringify({ command: "sudo ls" })}`)
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 5_000 })
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)

  // The agent saves a memory item; the panel lists it and the user can add, edit and delete.
  await send(page, `TOOL save_memory ${JSON.stringify({ text: "Likes green tea" })}`)
  await settled(page)
  await page.getByTestId("tool-card").last().locator("summary").click()
  await expect(page.getByTestId("memory-undo")).toBeVisible()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("memory-item")).toHaveCount(1)
  await page.getByTestId("memory-input").fill("Lives in Busan")
  await page.getByTestId("memory-add").click()
  await expect(page.getByTestId("memory-item")).toHaveCount(2)
  await page.getByTestId("memory-search").fill("busan")
  await expect(page.getByTestId("memory-item")).toHaveCount(1)
  await page.getByTestId("memory-edit").click()
  await page.getByTestId("memory-edit-input").fill("Lives in Seoul")
  await page.getByTestId("memory-save").click()
  await page.getByTestId("memory-search").fill("seoul")
  await expect(page.getByTestId("memory-item")).toContainText("Lives in Seoul")
  await shot(page, "s10-03-memory")
  await page.getByTestId("memory-delete").click()
  await expect(page.getByTestId("memory-item")).toHaveCount(0)

  // The permission level: full access asks nothing.
  await page.getByTestId("agent-permission").getByText("Full access").click()
  await page.getByTestId("agent-submit").click()
  const gone = join(outside, "gone.txt")
  writeFileSync(gone, "x")
  await send(page, `TOOL run_command ${JSON.stringify({ command: `rm "${gone}"` })}`)
  await settled(page)
  await expect.poll(() => existsSync(gone)).toBe(false)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await app.close()
})
