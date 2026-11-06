import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// The log entries of a step that Read only refuses (spec 007): a refused step is in the action
// log, decided by the permission level.

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })

test("the Refused entries of Read only in the action log", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
  await page.getByTestId("chat-header-agent").click()
  await page.locator("[data-testid=agent-permission] label[data-value=read_only]").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
  const write = { path: "written.txt", content: "x" }
  await send(page, `TOOL write_file ${JSON.stringify(write)}`)
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Refused: read only")
  await send(page, `TOOL run_command ${JSON.stringify({ command: "touch touched.txt" })}`)
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Refused: read only")

  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  await page.getByTestId("action-log-result").getByText("Refused").click()
  const entries = page.getByTestId("action-log-entry")
  await expect(entries).toHaveCount(2)
  const file = entries.filter({ hasText: "written.txt" })
  await expect(file).toContainText("File")
  await expect(file.getByTestId("action-log-access")).toHaveAttribute("data-access", "write")
  await expect(file).toContainText("Refused")
  await expect(file).toContainText("Permission level")
  await expect(file).toContainText("Ada")
  const shell = entries.filter({ hasText: "touch touched.txt" })
  await expect(shell).toContainText("Shell command")
  await expect(shell).toContainText("Refused")
  await expect(shell).toContainText("Permission level")
  await shot(page, "read-only-log-01")

  await app.close()
  await mock.close()
})
