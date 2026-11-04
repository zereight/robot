import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow } from "./harness.ts"

// The diagnostic report of the Teams page (spec 028, 014). A stand-in site fills the place of
// Teams. The test gives the page a press, as the window does, and checks that the report counts it
// on both sides: the window that gave it, and the document that received it.

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

test("teams page: a press is counted by the window and by the document, and the report holds it", async () => {
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

    // "Copy a diagnostic report" says where the file is and keeps it in the logs folder.
    await page.getByTestId("teams-report").click()
    await expect(page.getByTestId("teams-report-state")).toContainText("diagnostic-report.txt")
    const report = readFileSync(join(userData, "logs", "diagnostic-report.txt"), "utf8")
    expect(report).toContain("ROBot diagnostic report")
    expect(report).toContain("== What the numbers say ==")
    // The document received the press and the click.
    expect(report).toMatch(/"pointerDown": [1-9]/)
    expect(report).toMatch(/"click": [1-9]/)
    expect(report).toMatch(/"screenDown": 1/)
    expect(report).toContain("went to the app screen under the page")
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
