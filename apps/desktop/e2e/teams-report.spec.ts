import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow } from "./harness.ts"

// The diagnostic report of the whole app (spec 014, 013, 028). It is made from Settings, Data, and
// it covers the app screen, the Teams page and the logs. A stand-in site fills the place of Teams.
// The test gives the page a press, as the window does, and checks that the report counts it on both
// sides: the window that gave it, and the document that received it.

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

test("diagnostic report: a press is counted by the window and by the document, for the app screen and for the Teams page", async () => {
  test.setTimeout(90_000)
  const stand = await startStandIn()
  const userData = freshUserData()
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_TEAMS_URL: stand.url,
  })
  await resizeWindow(app, 1500, 1000)
  try {
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-teams").click()
    await page.getByTestId("teams-setup").click()
    await page.getByTestId("teams-signin-button").click()
    await expect(page.getByTestId("teams-page-box")).toBeVisible()

    // The page is placed: its view is the top view of the window and takes input.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          const top = win?.contentView.children.at(-1) as Electron.WebContentsView | undefined
          // The stand-in has loaded: a press before that has no document to reach.
          return Boolean(
            top?.getVisible() &&
              top.getBounds().width > 100 &&
              top.webContents.getURL().startsWith("http://127.0.0.1") &&
              !top.webContents.isLoading(),
          )
        }),
      )
      .toBe(true)

    // A press at the top left of the page, where the stand-in has its button.
    const press = () =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        const top = win?.contentView.children.at(-1) as Electron.WebContentsView | undefined
        const wc = top?.webContents
        if (!wc) return false
        for (const type of ["mouseDown", "mouseUp"] as const)
          wc.sendInputEvent({ type, x: 40, y: 40, button: "left", clickCount: 1 })
        return true
      })
    expect(await press()).toBe(true)
    await expect.poll(() => stand.site.clicks).toBeGreaterThan(0)

    // A press that lands on the app screen under the page, inside its place, is counted apart: it is
    // the sign of a page that is drawn above a spot but does not get the press there.
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]?.webContents
      for (const type of ["mouseDown", "mouseUp"] as const)
        wc?.sendInputEvent({ type, x: 300, y: 600, button: "left", clickCount: 1 })
    })

    // "Copy a diagnostic report" is a row of Settings, Data, not of the Teams page. It keeps the
    // report in the logs folder. The Teams page goes away with the Teams settings, and its counts stay.
    await page.getByTestId("settings-nav-data").click()
    await page.getByTestId("data-report").click()
    await expect(page.getByTestId("data-report")).toHaveText("Copied")
    const report = readFileSync(join(userData, "logs", "diagnostic-report.txt"), "utf8")
    expect(report).toContain("ROBot diagnostic report")
    expect(report).toContain("== What the numbers say ==")
    // The document received the press and the click.
    expect(report).toMatch(/"pointerDown": [1-9]/)
    expect(report).toMatch(/"click": [1-9]/)
    expect(report).toMatch(/"screenDown": 1/)
    expect(report).toContain("went to the app screen under the page")
    // The app screen is counted too: the window gave it presses, and its document got them.
    expect(report).toMatch(/"page": "app"[\s\S]*?"nativeDown": [1-9]/)
    expect(report).toMatch(/"page": "app"[\s\S]*?"pointerDown": [1-9]/)
    expect(report).toContain("== Processes ==")
    expect(report).toContain("== Log: app")
    // The report knows the host of the page and holds no address beyond it.
    expect(report).toContain('"host": "127.0.0.1"')
    expect(report).not.toContain(stand.url)
    // The browser log holds the input lines, with no text of the page.
    const log = readFileSync(join(userData, "logs", "browser.log"), "utf8")
    expect(log).toContain('"event":"page_input"')
    expect(log).not.toContain("zz-label-zz")
    // The app log holds the window and the input that its screen took, as kinds and places.
    const appLog = readFileSync(join(userData, "logs", "app.log"), "utf8")
    expect(appLog).toContain('"event":"window_created"')
    expect(appLog).toContain('"event":"page_input"')
    expect(appLog).toContain('"target":"settings-nav-data"')
  } finally {
    await app.close()
    stand.server.close()
  }
})

test("diagnostic report: nothing in the window drags by the place of the page, also when the page sits at the top", async () => {
  test.setTimeout(90_000)
  const stand = await startStandIn()
  const userData = freshUserData()
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_TEAMS_URL: stand.url,
  })
  // The size of a new window, as the user has it.
  await resizeWindow(app, 1200, 800)
  try {
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-teams").click()
    await page.getByTestId("teams-setup").click()
    await page.getByTestId("teams-signin-button").click()
    await expect(page.getByTestId("teams-page-box")).toBeVisible()

    // The settings screen covers the whole window, and the header of the screen under it is a
    // drag area of the window. Scroll the page up to the top of the window, under that header.
    await page
      .getByTestId("teams-page-box")
      .evaluate((box) => box.scrollIntoView({ block: "start" }))
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0]
          const top = win?.contentView.children.at(-1) as Electron.WebContentsView | undefined
          return top?.getVisible() ? top.getBounds().y : 9999
        }),
      )
      .toBeLessThan(40)

    // The report is made while the page sits at the top, so it measures the box in its place.
    await page.evaluate(() => window.robot.invoke("app.diagnosticReport", undefined))
    const report = readFileSync(join(userData, "logs", "diagnostic-report.txt"), "utf8")
    expect(report).toContain('"dragAreasOver": []')
    expect(report).not.toContain("A drag area of the window lies over the place")
  } finally {
    await app.close()
    stand.server.close()
  }
})
