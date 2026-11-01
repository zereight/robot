import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

test("browser: open a page, read it, take control, give back, stop closes it", async () => {
  test.setTimeout(90_000)
  const site = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<title>Hello page</title><body><h1>Greetings from the test site</h1></body>")
  })
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const windows = () => app.windows().filter((w) => !w.isClosed()).length
  const before = windows()

  await send(page, `TOOL browser_open ${JSON.stringify({ url })}`)
  await expect(page.getByTestId("browser-bar")).toBeVisible({ timeout: 15_000 })
  expect(windows()).toBe(before + 1)
  await shot(page, "s11-01-browser-open")

  await send(page, "TOOL browser_read {}")
  await expect(page.getByTestId("message").last()).toContainText("Greetings from the test site", {
    timeout: 15_000,
  })

  await page.getByTestId("browser-control").click()
  await expect(page.getByTestId("browser-bar")).toHaveAttribute("data-control", "true")
  await page.getByTestId("browser-control").click()
  await expect(page.getByTestId("browser-bar")).toHaveAttribute("data-control", "false")

  // Close by the button.
  await page.getByTestId("browser-close").click()
  await expect(page.getByTestId("browser-bar")).toHaveCount(0)
  await expect.poll(windows).toBe(before)

  // Stop while the user holds the controls closes the window within 2 seconds.
  await send(page, `TOOL browser_open ${JSON.stringify({ url })}`)
  await expect(page.getByTestId("browser-bar")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("browser-control").click()
  await send(page, "TOOL browser_read {}")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("browser-bar")).toHaveCount(0, { timeout: 2_000 })
  await app.close()
  site.close()
})
