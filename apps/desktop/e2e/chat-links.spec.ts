import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const agentMessages = (page: Page) => page.locator("[data-testid=message][data-author=agent]")
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

test("chat links: a scheme-less link opens with https, a relative link is plain text", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-links-"))
  const opened = join(work, "opened.log")
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US", ROBOT_TEST_OPEN_LOG: opened }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  await send(page, "bare link please")
  const reply = agentMessages(page).last()
  const guide = reply.locator("a", { hasText: "the guide" })
  await expect(guide).toHaveAttribute("href", "https://www.example.com/guide")
  await expect(reply.locator("a", { hasText: "the docs" })).toHaveAttribute(
    "href",
    "https://example.com/docs",
  )
  // A relative link opens nothing, so it shows as plain words, not a link.
  await expect(reply).toContainText("local")
  await expect(reply.locator("a", { hasText: "local" })).toHaveCount(0)
  await settled(page)
  await shot(page, "links-01-reply")

  await guide.click()
  await expect.poll(() => readFileSync(opened, "utf8")).toContain("https://www.example.com/guide")
  await expect(page.getByTestId("toast-error")).toHaveCount(0)

  await app.close()
  await mock.close()
})
