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

/** The size that the page of the agent is laid out in. It does not depend on the window. */
const PAGE = { width: 1280, height: 800 }

/**
 * Sends a real click to the page of the agent, like a mouse would, at a point of the page in CSS
 * px. The view draws the page smaller or larger than its own size, so the point of the mouse is
 * the point of the page times the scale of the view. Returns the page title after.
 *
 * The scale is read from the bounds of the view, and a view that is hidden has the size of the
 * page itself, not the size that it has on the screen. The screen hides the view for a moment
 * each time its place is set again (for example when the user takes control), so the click waits
 * until the view shows. It reads the bounds and sends the click in one step, with no wait
 * between: nothing can hide the view in between. A view that does not show in time gives
 * "page not shown".
 */
const clickPage = (app: ElectronApplication, at: { x: number; y: number }) =>
  app.evaluate(
    async ({ BrowserWindow }, args) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "ROBot")
      const view = win?.contentView.children.find(
        (child) => (child as unknown as { webContents?: unknown }).webContents,
      ) as unknown as
        | {
            webContents: Electron.WebContents
            getBounds(): { width: number }
            getVisible(): boolean
          }
        | undefined
      if (!view) return "no page"
      const wc = view.webContents
      for (let waited = 0; !view.getVisible(); waited += 20) {
        if (waited >= 3_000) return "page not shown"
        await new Promise((r) => setTimeout(r, 20))
      }
      // From here to the two input events there is no wait.
      const scale = view.getBounds().width / args.page.width
      const point = { x: Math.round(args.at.x * scale), y: Math.round(args.at.y * scale) }
      wc.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 })
      wc.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 })
      await new Promise((r) => setTimeout(r, 300))
      return wc.getTitle()
    },
    { at, page: PAGE },
  )

test("browser: hidden until the user shows it, small or large, hide keeps it open, the agent can ask to look, take control, give back, stop closes it", async () => {
  test.setTimeout(90_000)
  const site = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    // The button fills the top left of the page, so a click at a known point hits it.
    res.end(
      "<title>Hello page</title><body style='margin:0'><button style='position:fixed;left:0;top:0;width:300px;height:200px' onclick='document.title=\"Clicked \"+event.clientX+\",\"+event.clientY'>Press</button><h1 style='margin-top:260px'>Greetings from the test site</h1></body>",
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
  expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])
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
  // The page keeps its own ratio (16:10) and sits in the middle of its box. It fills the box in
  // one direction, and never goes outside it. The small box has the same ratio, so it is filled.
  // The screen measures its box on each frame and then tells the app, so the page follows the box
  // a moment later, not at once. On a slow computer that moment is long. The check repeats until
  // the page sits in the box; a page that never gets there still fails when the time is up.
  const sameAs = (testId: string) =>
    expect(async () => {
      await sameAsOnce(testId)
    }).toPass({ timeout: 10_000 })
  const sameAsOnce = async (testId: string) => {
    const box = await page.getByTestId(testId).boundingBox()
    const [view] = await insideViews(app)
    expect(box).not.toBeNull()
    expect(view?.title).toBe("Hello page")
    const b = view?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
    const r = box ?? { x: 0, y: 0, width: 0, height: 0 }
    expect(Math.abs(b.width / b.height - PAGE.width / PAGE.height)).toBeLessThan(0.02)
    expect(b.x).toBeGreaterThanOrEqual(Math.round(r.x) - 1)
    expect(b.y).toBeGreaterThanOrEqual(Math.round(r.y) - 1)
    expect(b.x + b.width).toBeLessThanOrEqual(Math.round(r.x + r.width) + 1)
    expect(b.y + b.height).toBeLessThanOrEqual(Math.round(r.y + r.height) + 1)
    expect(
      Math.min(Math.abs(b.width - Math.round(r.width)), Math.abs(b.height - Math.round(r.height))),
    ).toBeLessThanOrEqual(1)
    // In the middle: the empty room at the two sides is the same, within a px.
    const roomX = b.x - Math.round(r.x) - (Math.round(r.x + r.width) - (b.x + b.width))
    const roomY = b.y - Math.round(r.y) - (Math.round(r.y + r.height) - (b.y + b.height))
    expect(Math.abs(roomX)).toBeLessThanOrEqual(2)
    expect(Math.abs(roomY)).toBeLessThanOrEqual(2)
    // The page has its own size, whatever the size of the view.
    expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])
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
  expect(await clickPage(app, { x: 40, y: 80 })).toBe("Hello page")
  await page.getByTestId("browser-control").click()
  await expect(page.getByTestId("browser-bar")).toHaveAttribute("data-control", "true")
  // While the user holds the page, a click reaches it, at the point of the page that the user
  // points at, also when the page is drawn smaller or larger than its own size.
  // The page is given its scale a moment after the view gets its size, so a click right after a
  // change of size can land off the point. The click repeats until it lands.
  await expect(async () => {
    const clicked = await clickPage(app, { x: 40, y: 80 })
    expect(clicked).toMatch(/^Clicked \d+,\d+$/)
    const [hitX, hitY] = clicked.replace("Clicked ", "").split(",").map(Number)
    expect(Math.abs((hitX ?? 0) - 40)).toBeLessThanOrEqual(3)
    expect(Math.abs((hitY ?? 0) - 80)).toBeLessThanOrEqual(3)
  }).toPass({ timeout: 10_000 })
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

test("browser: a smaller or larger window changes the scale of the page, not its size", async () => {
  test.setTimeout(90_000)
  const site = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    // The first script of the page writes the size that it sees into the title.
    res.end(
      "<title>none</title><script>document.title='first ' + innerWidth + 'x' + innerHeight</script><body>Sized page</body>",
    )
  })
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r))
  const port = (site.address() as AddressInfo).port
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  // A small window first: the page must see its own size from its first script on.
  await resizeWindow(app, 1000, 700)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const first = `first ${PAGE.width}x${PAGE.height}`
  const view = async () => (await insideViews(app))[0]
  const widthOfView = async () => (await view())?.bounds.width ?? 0
  const visibleViews = async () => (await insideViews(app)).filter((v) => v.visible).length

  // The page opens hidden. Its size is the same as for a page that shows.
  await send(page, `TOOL browser_open ${JSON.stringify({ url: `http://127.0.0.1:${port}/` })}`)
  await expect(page.getByTestId("browser-card")).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => (await view())?.title, { timeout: 15_000 }).toBe(first)
  expect(await visibleViews()).toBe(0)
  expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])

  // Small, in the activity panel: the size is the same.
  await page.getByTestId("browser-show").click()
  await expect(page.getByTestId("browser-thumb")).toBeVisible()
  await expect.poll(visibleViews, { timeout: 5_000 }).toBe(1)
  expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])

  // The large view fills the conversation area, so it follows the window: the view grows and
  // shrinks with the window and the page keeps its size.
  await page.getByTestId("browser-enlarge").click()
  await expect(page.getByTestId("browser-bar")).toBeVisible()
  await expect.poll(widthOfView, { timeout: 5_000 }).toBeGreaterThan(300)
  const atSmallWindow = await widthOfView()
  expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])
  await resizeWindow(app, 1500, 950)
  await expect.poll(widthOfView, { timeout: 5_000 }).toBeGreaterThan(atSmallWindow + 100)
  expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])
  const atLargeWindow = await widthOfView()
  await resizeWindow(app, 1000, 700)
  await expect.poll(widthOfView, { timeout: 5_000 }).toBeLessThan(atLargeWindow - 100)
  expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])
  // The view keeps the ratio of the page, so a change of the window never squeezes the page.
  const shape = (await view())?.bounds
  const ratio = (shape?.width ?? 0) / (shape?.height ?? 1)
  expect(Math.abs(ratio - PAGE.width / PAGE.height)).toBeLessThan(0.02)

  // A new address keeps the size, and its first script sees it, in a small window as well.
  await send(
    page,
    `TOOL browser_open ${JSON.stringify({ url: `http://127.0.0.1:${port}/?second` })}`,
  )
  await expect.poll(async () => (await view())?.title, { timeout: 15_000 }).toBe(first)
  expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])
  // Another chat hides the page. It keeps its size for the agent.
  await createAgent(page, "Bo")
  await expect.poll(visibleViews, { timeout: 5_000 }).toBe(0)
  expect(await pageSize(app)).toEqual([PAGE.width, PAGE.height])
  await app.close()
  site.close()
})

test("browser: a click returns a short state, an unclear target lists candidates, a read lists numbered controls", async () => {
  test.setTimeout(90_000)
  const site = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(
      `<title>T</title><body><button class="pick" onclick="document.title='got-1'">B1</button><button class="pick" onclick="document.title='got-2'">B2</button></body>`,
    )
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

  // The chat shows the first 80 characters of each tool answer (mock-provider), so every
  // check below reads a prefix of the new output.
  await send(page, `TOOL browser_click ${JSON.stringify({ selector: ".pick" })}`)
  await expect(page.getByTestId("message").last()).toContainText("fits 2 controls", {
    timeout: 15_000,
  })
  await expect(page.getByTestId("message").last()).toContainText('[1] button "B1"')

  // The agent picks the first candidate by its number. The click lands on B1: the title says so.
  await send(page, `TOOL browser_click ${JSON.stringify({ selector: "1" })}`)
  await expect(page.getByTestId("message").last()).toContainText("Clicked.", { timeout: 15_000 })
  await expect(page.getByTestId("message").last()).toContainText("Address:")
  await expect(page.getByTestId("message").last()).toContainText("Loading:")

  // The read lists the numbered controls after the text, in the same answer.
  await send(page, "TOOL browser_read {}")
  await expect(page.getByTestId("message").last()).toContainText("Title: got-1", {
    timeout: 15_000,
  })
  await expect(page.getByTestId("message").last()).toContainText("Controls:")
  await expect(page.getByTestId("message").last()).toContainText('[1] button "B1"')
  await shot(page, "s11-04-browser-short-state")
  await app.close()
  site.close()
})
