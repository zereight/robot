import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { type ElectronApplication, expect, test } from "@playwright/test"
import { freshUserData, launch } from "./harness.ts"

// The Teams page (spec 028, 014). A stand-in site fills the place of Teams. The page has a window of
// its own: a view above the screen of the app did not take the pointer, the wheel or the keys of
// the user on every computer. The test gives the window a press, as the system does, and checks
// that the report counts it on both sides: the window that gave it, and the document that received
// it.

const startStandIn = async () => {
  const site = { clicks: 0 }
  const server = createServer((req, res) => {
    if (req.url === "/clicked") {
      site.clicks++
      res.writeHead(204).end()
      return
    }
    res.writeHead(200, { "content-type": "text/html" })
    res.end(`<title>Sign in</title><body style="margin:0">
      <button style="position:fixed;left:0;top:0;width:300px;height:200px"
        onclick="fetch('/clicked')">zz-label-zz</button></body>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { site, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server }
}

/** The window of the Teams page: the one that shows the stand-in site. */
const teamsWindow = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }, base) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(base))
    return win
      ? {
          visible: win.isVisible(),
          loading: win.webContents.isLoading(),
        }
      : undefined
  }, "http://127.0.0.1")

test("teams page: it opens in a window of its own, a press is counted by the window and by the document, and the report holds it", async () => {
  test.setTimeout(90_000)
  const stand = await startStandIn()
  const userData = freshUserData()
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_TEAMS_URL: stand.url,
  })
  try {
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-teams").click()
    await page.getByTestId("teams-setup").click()
    // Nothing shows before the user asks for it.
    expect(await teamsWindow(app)).toBeUndefined()
    await page.getByTestId("teams-signin-button").click()
    await expect(page.getByTestId("teams-page-box")).toBeVisible()

    // The page is a window of its own, shown, and loaded.
    await expect
      .poll(async () => {
        const w = await teamsWindow(app)
        return Boolean(w?.visible && !w.loading)
      })
      .toBe(true)

    // A press at the top left of the page, where the stand-in has its button.
    const press = () =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith("http://127.0.0.1"),
        )
        if (!win) return false
        for (const type of ["mouseDown", "mouseUp"] as const)
          win.webContents.sendInputEvent({ type, x: 40, y: 40, button: "left", clickCount: 1 })
        return true
      })
    expect(await press()).toBe(true)
    await expect.poll(() => stand.site.clicks).toBeGreaterThan(0)

    // "Copy a diagnostic report" keeps the report in the logs folder.
    await page.getByTestId("teams-report").click()
    await expect(page.getByTestId("teams-report")).toHaveText("Copied")
    const report = readFileSync(join(userData, "logs", "diagnostic-report.txt"), "utf8")
    expect(report).toContain("ROBot diagnostic report")
    expect(report).toContain("== What the numbers say ==")
    // The window gave the press, and the document received the press and the click.
    expect(report).toMatch(/"nativeDown": [1-9]/)
    expect(report).toMatch(/"pointerDown": [1-9]/)
    expect(report).toMatch(/"click": [1-9]/)
    expect(report).toContain('"inWindow": "own"')
    // The report knows the host of the page and holds no address beyond it.
    expect(report).toContain('"host": "127.0.0.1"')
    expect(report).not.toContain(stand.url)
    // The browser log holds the input lines, with no text of the page.
    const log = readFileSync(join(userData, "logs", "browser.log"), "utf8")
    expect(log).toContain('"event":"page_input"')
    expect(log).not.toContain("zz-label-zz")
  } finally {
    await app.close()
    stand.server.close()
  }
})

test("teams page: hide hides the window, and a window that the user closes is not shown any more", async () => {
  test.setTimeout(90_000)
  const stand = await startStandIn()
  const userData = freshUserData()
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_TEAMS_URL: stand.url,
  })
  try {
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-teams").click()
    await page.getByTestId("teams-setup").click()
    await page.getByTestId("teams-signin-button").click()
    await expect.poll(async () => (await teamsWindow(app))?.visible).toBe(true)
    await expect(page.getByTestId("teams-page-toggle")).toHaveText("Hide the Teams page")

    // "Hide the Teams page" takes the window away.
    await page.getByTestId("teams-page-toggle").click()
    await expect(page.getByTestId("teams-page-toggle")).toHaveText("Show the Teams page")
    await expect(page.getByTestId("teams-page-box")).toHaveCount(0)
    await expect.poll(async () => (await teamsWindow(app))?.visible ?? false).toBe(false)

    // Shown again, then closed by the user with the button of the window: the screen says that the
    // page is not shown.
    await page.getByTestId("teams-page-toggle").click()
    await expect.poll(async () => (await teamsWindow(app))?.visible).toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith("http://127.0.0.1"))
        ?.close()
    })
    await expect(page.getByTestId("teams-page-toggle")).toHaveText("Show the Teams page")
    await expect(page.getByTestId("teams-page-box")).toHaveCount(0)
  } finally {
    await app.close()
    stand.server.close()
  }
})
