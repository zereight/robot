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

/** The size that the page of the agent reports to its own scripts, in the first window that holds one. */
const pageSize = (app: ElectronApplication) =>
  app.evaluate(async ({ BaseWindow }) => {
    for (const window of BaseWindow.getAllWindows())
      for (const child of window.contentView.children) {
        const wc = (child as unknown as { webContents?: Electron.WebContents }).webContents
        if (wc && !wc.isDestroyed())
          return (await wc.executeJavaScript("[innerWidth, innerHeight]")) as [number, number]
      }
    return [0, 0] as [number, number]
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

test("browser: hidden until the user shows it, small or large, hide keeps it open, the agent can ask to look, take control, give back, stop closes it", async () => {
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
  // The page opens in the background. The activity panel has one quiet line, and the user does not
  // see the page. The chat is not split: no large bar shows.
  await expect(page.getByTestId("browser-card")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("browser-thumb")).toHaveCount(0)
  await expect(page.getByTestId("browser-bar")).toHaveCount(0)
  // The page opens inside the app window: no other window shows up. The page exists, and it is
  // hidden.
  expect(await windows()).toBe(before)
  await expect.poll(async () => (await insideViews(app)).length, { timeout: 5_000 }).toBe(1)
  expect((await insideViews(app)).filter((v) => v.visible).length).toBe(0)
  // A page that nobody sees still lays out like a page in a normal window, not at a size of 0.
  expect((await pageSize(app))[0]).toBeGreaterThanOrEqual(1000)
  // The agent reads the page while it is hidden.
  await send(page, "TOOL browser_read {}")
  await expect(page.getByTestId("message").last()).toContainText("Greetings from the test site", {
    timeout: 15_000,
  })
  await shot(page, "s11-00-browser-hidden")

  // The user shows the page. It sits in the box that the activity panel keeps for it.
  await page.getByTestId("browser-show").click()
  await expect(page.getByTestId("browser-thumb")).toBeVisible()
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(1)
  const sameAs = async (testId: string) => {
    const box = await page.getByTestId(testId).boundingBox()
    const [view] = await insideViews(app)
    expect(box).not.toBeNull()
    expect(view?.title).toBe("Hello page")
    expect(Math.abs((view?.bounds.x ?? 0) - Math.round(box?.x ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((view?.bounds.y ?? 0) - Math.round(box?.y ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((view?.bounds.width ?? 0) - Math.round(box?.width ?? 0))).toBeLessThanOrEqual(1)
    expect(Math.abs((view?.bounds.height ?? 0) - Math.round(box?.height ?? 0))).toBeLessThanOrEqual(
      1,
    )
  }
  await sameAs("browser-thumb")
  // The chat keeps its full width beside the panel: the box of the message is as wide as the
  // conversation area minus nothing for the page.
  const chat = await page.getByTestId("conversation").boundingBox()
  const composer = await page.getByTestId("composer-input").boundingBox()
  expect(chat).not.toBeNull()
  expect(composer?.width ?? 0).toBeGreaterThan((chat?.width ?? 0) * 0.6)
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

  // A click on the enlarge button makes the page fill the conversation area, under the header.
  await page.getByTestId("browser-enlarge").click()
  await expect(page.getByTestId("browser-bar")).toBeVisible()
  await expect(page.getByTestId("browser-card")).toHaveCount(0)
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(1)
  await sameAs("browser-view")
  await shot(page, "s11-02-browser-large")
  // The button that makes it small puts it back in the panel.
  await page.getByTestId("browser-shrink").click()
  await expect(page.getByTestId("browser-card")).toBeVisible()
  await expect(page.getByTestId("browser-bar")).toHaveCount(0)
  await sameAs("browser-thumb")
  await page.getByTestId("browser-enlarge").click()
  await expect(page.getByTestId("browser-bar")).toBeVisible()

  // While the agent holds the page, a click of the user does not reach it.
  expect(await clickPage(app)).toBe("Hello page")
  await page.getByTestId("browser-control").click()
  await expect(page.getByTestId("browser-bar")).toHaveAttribute("data-control", "true")
  // While the user holds the page, a click reaches it.
  expect(await clickPage(app)).toBe("Clicked")
  await page.getByTestId("browser-control").click()
  await expect(page.getByTestId("browser-bar")).toHaveAttribute("data-control", "false")

  // Another chat hides the page. It stays open for the agent. The chat of the agent shows it again
  // as hidden: the user left it large only for that visit, and shows it again when they want.
  await createAgent(page, "Bo")
  await expect(page.getByTestId("browser-bar")).toHaveCount(0)
  await expect(page.getByTestId("browser-card")).toHaveCount(0)
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(0)
  expect((await insideViews(app)).length).toBe(1)
  await page.locator('[data-place-row][data-place-name="Ada"]').click()
  await expect(page.getByTestId("browser-card")).toBeVisible()
  await expect(page.getByTestId("browser-thumb")).toHaveCount(0)
  expect((await insideViews(app)).filter((v) => v.visible).length).toBe(0)

  // Hide does not close the page. The user shows it large, hides it, and the agent goes on with it.
  await page.getByTestId("browser-show").click()
  await page.getByTestId("browser-enlarge").click()
  await expect(page.getByTestId("browser-bar")).toBeVisible()
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(1)
  await page.getByTestId("browser-hide").click()
  await expect(page.getByTestId("browser-bar")).toHaveCount(0)
  await expect(page.getByTestId("browser-card")).toBeVisible()
  await expect(page.getByTestId("browser-thumb")).toHaveCount(0)
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(0)
  expect((await insideViews(app)).length).toBe(1)
  await send(page, "TOOL browser_read {}")
  await expect(page.getByTestId("message").last()).toContainText("Greetings from the test site", {
    timeout: 15_000,
  })
  expect(await windows()).toBe(before)

  // The agent asks the user to look. Nothing shows until the user says yes, and "Not now" leaves the
  // page open and hidden.
  await send(page, `TOOL browser_ask_look ${JSON.stringify({ reason: "Enter the code" })}`)
  await expect(page.getByTestId("browser-ask")).toContainText("Enter the code", { timeout: 15_000 })
  await expect(page.getByTestId("browser-thumb")).toHaveCount(0)
  expect((await insideViews(app)).filter((v) => v.visible).length).toBe(0)
  await shot(page, "s11-03-browser-asks")
  await page.getByTestId("browser-ask-no").click()
  await expect(page.getByTestId("browser-ask")).toHaveCount(0)
  expect((await insideViews(app)).filter((v) => v.visible).length).toBe(0)
  await send(page, `TOOL browser_ask_look ${JSON.stringify({ reason: "Enter the code" })}`)
  await expect(page.getByTestId("browser-ask")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("browser-ask-show").click()
  await expect(page.getByTestId("browser-ask")).toHaveCount(0)
  await expect(page.getByTestId("browser-thumb")).toBeVisible()
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(1)
  await page.getByTestId("browser-hide").click()
  await expect(page.getByTestId("browser-thumb")).toHaveCount(0)

  // Stop while the user holds the controls closes the window within 2 seconds.
  await send(page, `TOOL browser_open ${JSON.stringify({ url })}`)
  await expect(page.getByTestId("browser-card")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("browser-show").click()
  await page.getByTestId("browser-enlarge").click()
  await page.getByTestId("browser-control").click()
  // The large page covers the chat, so the user makes it small to reach the box. The card still
  // says that the user holds the page, and it can give it back.
  await page.getByTestId("browser-shrink").click()
  await expect(page.getByTestId("browser-card")).toHaveAttribute("data-control", "true")
  await expect(page.getByTestId("browser-card-give-back")).toBeVisible()
  await send(page, "TOOL browser_read {}")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await page.getByTestId("composer-stop").click()
  await expect(page.getByTestId("browser-card")).toHaveCount(0, { timeout: 2_000 })
  await app.close()
  site.close()
})

test("browser: closing the app window does not end the browser work of the agent (macOS)", async () => {
  test.skip(process.platform !== "darwin", "Other systems quit with the window.")
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
  await send(page, `TOOL browser_open ${JSON.stringify({ url })}`)
  await expect(page.getByTestId("browser-card")).toBeVisible({ timeout: 15_000 })

  /** The pages that wait on a window that nobody sees: where they are, and what they report. */
  const onShelf = () =>
    app.evaluate(async ({ BaseWindow, BrowserWindow }) => {
      const shelf = BaseWindow.getAllWindows().filter((w) => !(w instanceof BrowserWindow))
      const found: { title: string; visible: boolean; probe: unknown }[] = []
      for (const window of shelf) {
        for (const child of window.contentView.children) {
          const view = child as unknown as {
            getVisible(): boolean
            webContents: Electron.WebContents
          }
          if (view.webContents.isDestroyed()) continue
          found.push({
            title: view.webContents.getTitle(),
            visible: view.getVisible(),
            probe: await view.webContents.executeJavaScript(
              "[document.visibilityState, innerWidth, innerHeight]",
            ),
          })
        }
      }
      return { windows: shelf.length, found }
    })

  // The user closes the app window. The page is not closed: it waits on a window that nobody sees.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === "ROBot")
      ?.close()
  })
  await expect.poll(async () => (await onShelf()).found.length, { timeout: 10_000 }).toBe(1)
  const waiting = await onShelf()
  expect(waiting.found[0]?.title).toBe("Hello page")
  expect(waiting.found[0]?.visible).toBe(false)
  expect(((waiting.found[0]?.probe ?? []) as number[])[1]).toBeGreaterThanOrEqual(1000)
  test.info().annotations.push({ type: "page while hidden", description: JSON.stringify(waiting) })

  // The user opens the app again. The page comes back to the new window, still hidden, and the
  // agent reads it.
  const opened = app.waitForEvent("window")
  await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"))
  const page2 = await opened
  await page2.waitForLoadState("domcontentloaded")
  await page2.locator('[data-place-row][data-place-name="Ada"]').click()
  await expect(page2.getByTestId("browser-card")).toBeVisible({ timeout: 15_000 })
  await expect(page2.getByTestId("browser-thumb")).toHaveCount(0)
  expect((await onShelf()).found.length).toBe(0)
  await send(page2, "TOOL browser_read {}")
  await expect(page2.getByTestId("message").last()).toContainText("Greetings from the test site", {
    timeout: 15_000,
  })
  // The user shows it: it sits in the new window.
  await page2.getByTestId("browser-show").click()
  await expect(page2.getByTestId("browser-thumb")).toBeVisible()
  await expect
    .poll(async () => (await insideViews(app)).filter((v) => v.visible).length, { timeout: 5_000 })
    .toBe(1)
  await app.close()
  site.close()
})
