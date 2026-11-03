import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
const tools = (...calls: { name: string; args: unknown }[]) => `TOOLS ${JSON.stringify(calls)}`

/** A test server that keeps the bodies of what a command sends to it. */
const startReceiver = async () => {
  const bodies: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      if (req.url === "/post") bodies.push(Buffer.concat(chunks).toString("utf8"))
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<html><body><p>A page.</p></body></html>")
    })
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  return {
    bodies,
    post: `http://127.0.0.1:${port}/post`,
    page: `http://127.0.0.1:${port}/page`,
    close: () => server.close(),
  }
}

/** A test home folder with a stand-in key. The app uses it instead of the home of the user. */
const makeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "robot-e2e-home-"))
  mkdirSync(join(home, ".ssh"), { recursive: true })
  writeFileSync(join(home, ".ssh", "id_test"), "stand-in key")
  return home
}

test("sensitive places: read, ask, header line, Clear, refused address, log, restart", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const receiver = await startReceiver()
  const home = makeHome()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US", ROBOT_TEST_HOME: home }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const curl = {
    name: "run_command",
    args: { command: `curl -s -d secret ${receiver.post}` },
  }
  const readKey = { name: "read_file", args: { path: join(home, ".ssh", "id_test") } }
  const report: string[] = ["# S81 sensitive places", ""]

  // A command that sends data asks at "Ask for risky steps". "Always allow" saves the rule for it.
  await send(page, tools(curl))
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("ask-sensitive")).toHaveCount(0)
  await page.getByTestId("ask-always").click()
  await settled(page)
  await expect.poll(() => receiver.bodies.length).toBe(1)
  await expect(page.getByTestId("place-marks")).toHaveCount(0)
  report.push("1. A curl command asks once. Always allow saves the rule. The line has no mark.")

  // A read of a file in a credential place of the test home: it is outside the workspace, so it asks.
  await send(page, tools(readKey))
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("ask-allow").click()
  await settled(page)
  const line = page.getByTestId("place-marks")
  await expect(line).toBeVisible()
  await expect(line).toContainText("Holds a sensitive read")
  await expect(page.getByTestId("place-mark-first")).toContainText("First place: Keys")
  await expect(page.getByTestId("place-marks-clear")).toBeVisible()
  await shot(page, "s81-01-header-line")
  report.push(
    "2. The agent reads a test key file. The header line shows:",
    `   ${((await line.textContent()) ?? "").trim()}`,
  )

  // The next turn holds the read: the same command asks, though the rule allows it.
  await send(page, tools(curl))
  const card = page.getByTestId("ask-card")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("ask-sensitive")).toContainText(
    "This turn read a place with keys or logins.",
  )
  await expect(page.getByTestId("ask-sensitive-label")).toContainText("First place: Keys")
  await expect(page.getByTestId("ask-allow")).toBeVisible()
  await expect(page.getByTestId("ask-deny")).toBeVisible()
  await expect(page.getByTestId("ask-always")).toHaveCount(0)
  await shot(page, "s81-02-sensitive-card")
  report.push(
    "3. Next turn, the same curl command asks with Allow once and Deny only, and the line:",
    `   ${((await page.getByTestId("ask-sensitive").textContent()) ?? "").trim()}`,
  )
  await page.getByTestId("ask-deny").click()
  await settled(page)
  expect(receiver.bodies).toEqual(["secret"])

  // The line and the card stay after a restart.
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1300, 860)
  await page.locator("[data-place-row]").filter({ hasText: "Ada" }).first().click()
  await expect(page.getByTestId("place-marks")).toContainText("Holds a sensitive read")
  await expect(page.getByTestId("place-mark-first")).toContainText("First place: Keys")
  report.push("4. After a restart, the header line shows the same words.")

  // "Clear" asks first. Cancel changes nothing; Clear removes the line.
  await page.getByTestId("place-marks-clear").click()
  const dialog = page.getByTestId("place-marks-dialog")
  await expect(dialog).toContainText('Clear "Holds a sensitive read"?')
  await expect(dialog).toContainText("The agent still sees what it read.")
  await shot(page, "s81-03-clear-confirm")
  await dialog.getByText("Cancel").click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("place-marks")).toBeVisible()
  await page.getByTestId("place-marks-clear").click()
  await page.getByTestId("place-marks-confirm").click()
  await expect(page.getByTestId("place-marks")).toHaveCount(0)
  report.push("5. Clear asks first. Cancel keeps the line. Clear removes it.")

  // After "Clear", the same command runs by the rule.
  await send(page, tools(curl))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await expect.poll(() => receiver.bodies.length).toBe(2)
  report.push("6. After Clear, the same curl command runs by the rule with no card.")

  // A fetch of an address that is never allowed is refused, also at "Full access".
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("agent-permission").getByText("Full access").click()
  await page.getByTestId("full-access-use").click()
  await page.getByTestId("agent-submit").click()
  await send(page, tools({ name: "fetch_url", args: { url: "http://169.254.169.254/latest/" } }))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  const state = page.getByTestId("tool-state").last()
  await expect(state).toHaveText("Refused: this address is not allowed")
  await expect(state).toHaveAttribute("data-state", "refused")
  await shot(page, "s81-04-refused-address")
  report.push(
    "7. Full access, fetch of 169.254.169.254: no card.",
    `   ${(await state.textContent()) ?? ""}`,
  )

  // At "Full access" a fetch after a read runs with no question, and the log says so.
  await send(page, tools(readKey, { name: "fetch_url", args: { url: receiver.page } }))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await expect(page.getByTestId("place-marks")).toContainText("Holds a sensitive read")
  report.push("8. Full access, read then fetch: no card. The line shows again.")

  // The action log: the refusal names the app, and the entries after a read name the label.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  const entries = page.getByTestId("action-log-entry")
  const refused = entries.filter({ hasText: "169.254.169.254" })
  await expect(refused).toHaveCount(1)
  await expect(refused).toContainText("Refused")
  await expect(refused).toContainText("The app")
  await expect(refused).toContainText("No sensitive read")
  const afterRead = entries.filter({ hasText: "Web page" }).filter({ hasText: receiver.page })
  await expect(afterRead).toHaveCount(1)
  await expect(afterRead).toHaveAttribute("data-sensitive", "true")
  await expect(afterRead).toContainText("Sensitive read: Keys")
  await expect(afterRead).toContainText("Ran")
  const denied = entries.filter({ hasText: "curl" }).filter({ hasText: "You, on a card" })
  await expect(denied.first()).toContainText("Refused")
  await expect(denied.first()).toContainText("Sensitive read: Keys")
  await shot(page, "s81-05-action-log")
  report.push("9. Action log, newest first:")
  for (const text of await entries.allInnerTexts())
    report.push(`   - ${text.replace(/\n/g, " | ")}`)

  const reports = resolve(shotsDir, "..", "reports")
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, "s81-sensitive-places.md"), `${report.join("\n")}\n`)
  await app.close()
  receiver.close()
})

test("sensitive places: a start file asks as a risky step, and a local address asks once for its host", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const receiver = await startReceiver()
  const home = makeHome()
  writeFileSync(join(home, ".zshrc"), "# stand-in start file\n")
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_HOME: home,
  })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A write to a start file asks, as a risky step. Deny keeps the file as it was.
  await send(
    page,
    tools({ name: "write_file", args: { path: join(home, ".zshrc"), content: "# changed\n" } }),
  )
  const card = page.getByTestId("ask-card")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText(join(home, ".zshrc"))
  await expect(page.getByTestId("ask-always")).toBeVisible()
  await shot(page, "s81-06-control-place-card")
  await page.getByTestId("ask-deny").click()
  await settled(page)
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# stand-in start file\n")

  // A fetch of a page on this computer asks; "Always allow" keeps a rule for the host.
  await send(page, tools({ name: "fetch_url", args: { url: receiver.page } }))
  await expect(card).toContainText(receiver.page, { timeout: 15_000 })
  await page.getByTestId("ask-always").click()
  await settled(page)
  await send(page, tools({ name: "fetch_url", args: { url: receiver.page } }))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await expect(page.getByTestId("tool-state").last()).toHaveAttribute("data-state", "done")
  await app.close()
  receiver.close()
})
