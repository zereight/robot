import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { type ElectronApplication, expect, test } from "@playwright/test"
import { connectMock, createAgent, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

/**
 * A local test page. The controls sit at fixed places, so a click at a known point hits them:
 * the button at the top left, then the field "Name", then the field "Password".
 */
const PAGE = `<!doctype html><title>Teach test page</title>
<body style="margin:0;font:14px sans-serif">
<button id="press" style="position:fixed;left:0;top:0;width:300px;height:100px"
  onclick="document.title='Pressed'">Press</button>
<label for="name" style="position:fixed;left:320px;top:130px">Name</label>
<input id="name" style="position:fixed;left:10px;top:130px;width:280px;height:30px">
<label for="pw" style="position:fixed;left:320px;top:190px">Password</label>
<input id="pw" type="password" style="position:fixed;left:10px;top:190px;width:280px;height:30px">
</body>`

/** Real input to the page of the agent, as a mouse and a keyboard give it. */
const input = (
  app: ElectronApplication,
  action: { click?: { x: number; y: number }; type?: string; key?: string },
) =>
  app.evaluate(async ({ BrowserWindow }, act) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "ROBot")
    const view = win?.contentView.children.find(
      (child) => (child as unknown as { webContents?: unknown }).webContents,
    ) as unknown as { webContents: Electron.WebContents } | undefined
    if (!view) return "no page"
    const wc = view.webContents
    if (act.click) {
      const at = { ...act.click, button: "left" as const, clickCount: 1 }
      wc.sendInputEvent({ type: "mouseDown", ...at })
      wc.sendInputEvent({ type: "mouseUp", ...at })
    }
    for (const ch of act.type ?? "") {
      wc.sendInputEvent({ type: "keyDown", keyCode: ch })
      wc.sendInputEvent({ type: "char", keyCode: ch })
      wc.sendInputEvent({ type: "keyUp", keyCode: ch })
    }
    if (act.key) {
      wc.sendInputEvent({ type: "keyDown", keyCode: act.key })
      wc.sendInputEvent({ type: "keyUp", keyCode: act.key })
    }
    await new Promise((r) => setTimeout(r, 300))
    return wc.getTitle()
  }, action)

/** True when the page of the agent shows in the app window. */
const pageShows = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "ROBot")
    return (win?.contentView.children ?? []).some((child) =>
      (child as unknown as { getVisible(): boolean }).getVisible(),
    )
  })

test("teach a task: record steps in the agent browser, hide the password, draft, save, try it", async () => {
  test.setTimeout(120_000)
  const site = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end(PAGE)
  })
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`
  const mock = await startMockProvider()
  const { app, page, userData } = await launch(undefined, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // The form: the result of the task, 1 to 500 characters.
  await page.getByTestId("chat-header-menu").click()
  await page.getByTestId("chat-menu-teach").click()
  await expect(page.getByTestId("teach-dialog")).toBeVisible()
  await expect(page.getByTestId("teach-start")).toBeDisabled()
  await page.getByTestId("teach-result").fill("Make the test page say hello")
  await shot(page, "s45-01-teach-form")
  await page.getByTestId("teach-start").click()

  // The browser opens with the user in control, under the teaching bar.
  const bar = page.getByTestId("teach-bar")
  await expect(bar).toBeVisible()
  await expect(bar).toContainText("Teaching")
  await expect(bar).toContainText("Make the test page say hello")
  await expect(page.getByTestId("browser-bar")).toHaveCount(0)
  await expect(page.getByTestId("teach-steps")).toHaveText("Steps: 0")

  // The user opens the test page from the bar: the page is the first step.
  await page.getByTestId("teach-address").fill(url)
  await page.getByTestId("teach-open").click()
  await expect(page.getByTestId("teach-steps")).toHaveText("Steps: 1", { timeout: 10_000 })

  // A click on the button. The page shows once the form has gone.
  await expect.poll(() => pageShows(app), { timeout: 5_000 }).toBe(true)
  expect(await input(app, { click: { x: 60, y: 40 } })).toBe("Pressed")
  await expect(page.getByTestId("teach-steps")).toHaveText("Steps: 2")

  // Paused: a click is not recorded.
  await page.getByTestId("teach-pause").click()
  await expect(bar).toContainText("Paused")
  await input(app, { click: { x: 60, y: 40 } })
  await expect(page.getByTestId("teach-steps")).toHaveText("Steps: 2")
  await page.getByTestId("teach-pause").click()
  await expect(bar).toContainText("Teaching")

  // "hello" into Name, Tab, a password into Password, Enter.
  await input(app, { click: { x: 100, y: 145 }, type: "hello", key: "Tab" })
  await input(app, { type: "hunter2-not-for-the-model", key: "Return" })
  await expect(page.getByTestId("teach-steps")).toHaveText("Steps: 6")
  await shot(page, "s45-02-teaching-bar")

  // Stop: one request to the model of the agent, with the steps and without the password.
  const before = mock.requests.length
  await page.getByTestId("teach-stop").click()
  await expect(page.getByTestId("teach-bar")).toHaveCount(0)
  const card = page.getByTestId("draft-card")
  await expect(card).toHaveAttribute("data-phase", "draft", { timeout: 15_000 })
  const asked = mock.requests
    .slice(before)
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => JSON.stringify(r.body))
  expect(asked.length).toBe(1)
  const request = asked[0] as string
  expect(request).toContain('Clicked the button \\"Press\\"')
  expect(request).toContain('Typed \\"hello\\" into Name')
  expect(request).toContain("Typed a secret into Password")
  expect(request).toContain("Pressed Enter")
  expect(request).not.toContain("hunter2")
  expect(request).toContain("Make the test page say hello")

  // The card: name, description and instructions to edit, and the number of steps.
  await expect(page.getByTestId("draft-steps")).toHaveText("Steps: 6")
  await expect(page.getByTestId("draft-name")).toHaveValue("Greet on the test page")
  await expect(page.getByTestId("draft-instructions")).toHaveValue(/Press the button/)
  await page.getByTestId("draft-name").fill("Say hello")
  await shot(page, "s45-03-draft-card")

  // Save: a skill for this agent only, turned on.
  await page.getByTestId("draft-save").click()
  await expect(page.getByTestId("draft-saved")).toHaveText("Saved")
  const db = new DatabaseSync(join(userData, "robot.db"), { readOnly: true })
  const agentId = (db.prepare("SELECT id FROM agent WHERE name = 'Ada'").get() as { id: string }).id
  expect(db.prepare("SELECT name, agents, enabled FROM skill").all()).toEqual([
    { name: "Say hello", agents: JSON.stringify([agentId]), enabled: 1 },
  ])
  db.close()
  await shot(page, "s45-04-saved")

  // Try it: the chip and the result text go in the message box, and the user sends them.
  await page.getByTestId("draft-try").click()
  await expect(page.getByTestId("draft-card")).toHaveCount(0)
  await expect(page.getByTestId("composer-skill")).toContainText("Say hello")
  await expect(page.getByTestId("composer-input")).toHaveValue("Make the test page say hello")
  const sent = mock.requests.length
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("message-skill")).toContainText("Say hello")
  await expect.poll(() => mock.requests.slice(sent).length).toBeGreaterThan(0)
  const turn = JSON.stringify(mock.requests.slice(sent).at(-1)?.body)
  expect(turn).toContain("Press the button")
  expect(turn.indexOf("Press the button")).toBeLessThan(
    turn.lastIndexOf("Make the test page say hello"),
  )
  await shot(page, "s45-05-try-it")

  // Cancel during a recording keeps nothing: no draft and no new skill.
  await page.getByTestId("chat-header-menu").click()
  await page.getByTestId("chat-menu-teach").click()
  await page.getByTestId("teach-result").fill("Something else")
  await page.getByTestId("teach-start").click()
  await expect(page.getByTestId("teach-bar")).toBeVisible()
  await expect.poll(() => pageShows(app), { timeout: 5_000 }).toBe(true)
  await input(app, { click: { x: 60, y: 40 } })
  await expect(page.getByTestId("teach-steps")).not.toHaveText("Steps: 0")
  const beforeCancel = mock.requests.length
  await page.getByTestId("teach-cancel").click()
  await expect(page.getByTestId("teach-bar")).toHaveCount(0)
  await expect(page.getByTestId("draft-card")).toHaveCount(0)
  expect(mock.requests.length).toBe(beforeCancel)
  const after = new DatabaseSync(join(userData, "robot.db"), { readOnly: true })
  expect(after.prepare("SELECT COUNT(*) AS n FROM skill").get()).toEqual({ n: 1 })
  after.close()

  // While one recording runs, another agent cannot start one, and says why.
  await page.getByTestId("chat-header-menu").click()
  await page.getByTestId("chat-menu-teach").click()
  await page.getByTestId("teach-result").fill("Third")
  await page.getByTestId("teach-start").click()
  await expect(page.getByTestId("teach-bar")).toBeVisible()
  await createAgent(page, "Bo")
  await page.getByTestId("chat-header-menu").click()
  await expect(page.getByTestId("chat-menu-teach")).toBeDisabled()
  await expect(page.getByTestId("chat-menu-teach-reason")).toContainText("Ada")
  await page.keyboard.press("Escape")
  await page.locator('[data-place-row][data-place-name="Ada"]').click()
  await page.getByTestId("teach-cancel").click()
  await expect(page.getByTestId("teach-bar")).toHaveCount(0)

  await app.close()
  await mock.close()
  site.close()
})
