import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { type ElectronApplication, expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

/** The pages that sit inside the app window as views: where they are, and what they show. */
const insideViews = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "ROBot")
    if (!win) return []
    return win.contentView.children.map((child) => {
      const view = child as unknown as {
        getBounds(): { x: number; y: number; width: number; height: number }
        getVisible(): boolean
        webContents?: { getTitle(): string; getURL(): string }
      }
      return {
        bounds: view.getBounds(),
        visible: view.getVisible(),
        title: view.webContents?.getTitle() ?? "",
      }
    })
  })

/** Sends a real click to the page of the agent, like a mouse would. Returns the page title after. */
const clickPage = (app: ElectronApplication) =>
  app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "ROBot")
    const view = win?.contentView.children.find(
      (child) => (child as unknown as { webContents?: unknown }).webContents,
    ) as unknown as { webContents: Electron.WebContents } | undefined
    if (!view) return "no page"
    const wc = view.webContents
    const point = { x: 40, y: 80 }
    wc.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 })
    wc.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 })
    await new Promise((r) => setTimeout(r, 300))
    return wc.getTitle()
  })

test("browser: open a page in the same window, read it, take control, give back, stop closes it", async () => {
  test.setTimeout(90_000)
  const site = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    // The button fills the top left of the page, so a click at a known point hits it.
    res.end(
      "<title>Hello page</title><body style='margin:0'><button style='position:fixed;left:0;top:0;width:300px;height:200px' onclick='document.title=\"Clicked\"'>Press</button><h1 style='margin-top:260px'>Greetings from the test site</h1></body>",
    )
  })
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  // Top level windows only. A page that sits inside the app window is not one of them.
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const before = await windows()

  await send(page, `TOOL browser_open ${JSON.stringify({ url })}`)
  await expect(page.getByTestId("browser-bar")).toBeVisible({ timeout: 15_000 })
  // The page opens inside the app window: no other window shows up, and the page sits in the box
  // that the chat screen keeps for it.
  expect(await windows()).toBe(before)
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(1)
  const box = await page.getByTestId("browser-view").boundingBox()
  const [view] = await insideViews(app)
  expect(box).not.toBeNull()
  expect(view?.title).toBe("Hello page")
  expect(Math.abs((view?.bounds.x ?? 0) - Math.round(box?.x ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((view?.bounds.y ?? 0) - Math.round(box?.y ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((view?.bounds.width ?? 0) - Math.round(box?.width ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((view?.bounds.height ?? 0) - Math.round(box?.height ?? 0))).toBeLessThanOrEqual(1)
  // The chat stays usable beside the page.
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await shot(page, "s11-01-browser-open")

  // A dialog draws under a page view, so the page hides while a dialog shows.
  await page.getByTestId("chat-header-model").click()
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(0)
  await page.keyboard.press("Escape")
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(1)

  await send(page, "TOOL browser_read {}")
  await expect(page.getByTestId("message").last()).toContainText("Greetings from the test site", {
    timeout: 15_000,
  })

  // While the agent holds the page, a click of the user does not reach it.
  expect(await clickPage(app)).toBe("Hello page")
  await page.getByTestId("browser-control").click()
  await expect(page.getByTestId("browser-bar")).toHaveAttribute("data-control", "true")
  // While the user holds the page, a click reaches it.
  expect(await clickPage(app)).toBe("Clicked")
  await page.getByTestId("browser-control").click()
  await expect(page.getByTestId("browser-bar")).toHaveAttribute("data-control", "false")

  // Another chat hides the page. It stays open for the agent. The chat of the agent shows it again.
  await createAgent(page, "Bo")
  await expect(page.getByTestId("browser-bar")).toHaveCount(0)
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(0)
  expect((await insideViews(app)).length).toBe(1)
  await page.locator('[data-place-row][data-place-name="Ada"]').click()
  await expect(page.getByTestId("browser-bar")).toBeVisible()
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(1)

  // Close by the button.
  await page.getByTestId("browser-close").click()
  await expect(page.getByTestId("browser-bar")).toHaveCount(0)
  await expect.poll(async () => (await insideViews(app)).length).toBe(0)
  expect(await windows()).toBe(before)

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
