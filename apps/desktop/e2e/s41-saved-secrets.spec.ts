import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { unzipSync } from "fflate"
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

const VALUE = "tok-e2e-Hq7Lm2Zx9Pw4-value"
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
const tools = (...calls: { name: string; args: unknown }[]) => `TOOLS ${JSON.stringify(calls)}`

/** A small test web service, written for this test (spec 020, "Acceptance"). */
const startTestService = async () => {
  const got: { path: string; method: string; auth: string }[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    const auth = String(req.headers.authorization ?? "")
    got.push({ path: url.pathname, method: req.method ?? "", auth })
    const token = auth.replace(/^Bearer /, "")
    if (url.pathname === "/echo") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(`plain ${token} base64 ${b64(token)}`)
      return
    }
    if (url.pathname === "/move") {
      res.writeHead(302, { location: "/elsewhere" })
      res.end()
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true, method: req.method }))
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const { port } = server.address() as AddressInfo
  return { origin: `http://127.0.0.1:${port}`, port, got, close: () => server.close() }
}

/** True when a file under the folder holds the text, as it is or as base64. */
const anyFileHolds = (dir: string, text: string): string | null => {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const data = readFileSync(path)
    if (data.includes(text) || data.includes(b64(text))) return path
  }
  return null
}

test("saved secrets: ask, use, redact, refuse, rule, settings, export and import", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const service = await startTestService()
  const work = mkdtempSync(join(tmpdir(), "robot-s41-"))
  const archive = join(work, "export.zip")
  const env = { ROBOT_SYSTEM_LOCALE: "en-US", ROBOT_TEST_SAVE_PATH: archive }
  const userData = freshUserData()
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const report: string[] = ["# S41 saved secrets", ""]
  const ask = (extra: Record<string, unknown> = {}) => ({
    name: "ask_secret",
    args: {
      name: "test_api",
      label: "Test API key",
      reason: "To read the test service.",
      origin: service.origin,
      send_as: "bearer",
      ...extra,
    },
  })
  const request = (url: string, method = "GET") => ({
    name: "secret_request",
    args: { name: "test_api", url, method },
  })
  const lastCard = () => page.getByTestId("tool-card").last()

  // Settings: no secrets yet; the switch for this computer is off and is turned on.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  await expect(page.getByTestId("saved-secrets-empty")).toBeVisible()
  await expect(page.getByTestId("setting-secrets-local")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("setting-secrets-local").click()
  await expect(page.getByTestId("setting-secrets-local")).toHaveAttribute("aria-checked", "true")
  await shot(page, "s41-01-settings-empty")
  await page.getByTestId("settings-close").click()
  report.push(
    "1. Settings, Permissions: no secrets (muted line). The local switch was off; now on.",
  )

  // Ask: the protected card shows the origin in large text. Save clears the field at once.
  await send(page, tools(ask()))
  const card = page.getByTestId("secret-card")
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("secret-origin")).toHaveText(service.origin)
  await expect(card).toContainText("Test API key")
  await expect(card).toContainText("To read the test service.")
  await expect(card).toContainText("Sent as a bearer token")
  await expect(page.getByTestId("secret-input")).toHaveAttribute("type", "password")
  await page.getByTestId("secret-input").fill(VALUE)
  await shot(page, "s41-02-protected-card")
  await page.getByTestId("secret-save").click()
  await expect(page.getByTestId("secret-card")).toHaveCount(0)
  await settled(page)
  await expect(lastCard().getByTestId("secret-result")).toHaveText("Saved")
  report.push(`2. Protected card: origin ${service.origin}, hidden field. Save: card shows Saved.`)

  // GET: the service gets the value; the agent gets the body with the value redacted.
  await send(page, tools(request(`${service.origin}/echo`)))
  await settled(page)
  expect(service.got.at(-1)).toEqual({ path: "/echo", method: "GET", auth: `Bearer ${VALUE}` })
  await expect(lastCard()).toContainText("plain [redacted] base64 [redacted]")
  await expect(lastCard()).toContainText(`[test_api] GET ${service.origin}/echo`)
  report.push("3. GET /echo: the service got `Bearer <value>`. The agent got:")
  report.push("   plain [redacted] base64 [redacted]")

  // Another port, and a redirect.
  const before = service.got.length
  await send(page, tools(request(`http://127.0.0.1:${service.port + 1}/echo`)))
  await settled(page)
  await expect(lastCard()).toContainText("same scheme, host and port")
  await send(page, tools(request(`${service.origin}/move`)))
  await settled(page)
  await expect(lastCard()).toContainText("Status: 302")
  await expect(lastCard()).toContainText(`Redirect to: ${service.origin}/elsewhere`)
  expect(service.got.slice(before).map((g) => g.path)).toEqual(["/move"])
  report.push(
    "4. Other port: refused, nothing sent. Redirect: not followed; status 302 and address.",
  )

  // POST at "Ask for risky steps": the card names the secret, the method and the address.
  await send(page, tools(request(`${service.origin}/items`, "POST")))
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("ask-card")).toContainText(
    `[test_api] POST ${service.origin}/items`,
  )
  await shot(page, "s41-03-post-approval")
  await page.getByTestId("ask-always").click()
  await settled(page)
  await send(page, tools(request(`${service.origin}/items`, "POST")))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  expect(service.got.filter((g) => g.path === "/items" && g.method === "POST")).toHaveLength(2)
  report.push("5. POST: approval card with name, method and address. Always allow: next POST ran.")

  // The same secret again: no card. With replace: a card. Cancel.
  const cards = await page.getByTestId("tool-card").count()
  await send(page, tools(ask()))
  await settled(page)
  await expect(page.getByTestId("tool-card")).toHaveCount(cards + 1)
  await expect(page.getByTestId("secret-card")).toHaveCount(0)
  await expect(lastCard()).toContainText("saved already")
  await send(page, tools(ask({ replace: true })))
  await expect(page.getByTestId("secret-card")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("secret-replace")).toBeVisible()
  await page.getByTestId("secret-cancel").click()
  await settled(page)
  await expect(lastCard().getByTestId("secret-result")).toHaveText("Cancelled")
  report.push("6. Ask again: no card. Ask with replace: card shows. Cancel: card shows Cancelled.")

  // The switch off: a request to 127.0.0.1 is refused with the reason.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  await page.getByTestId("setting-secrets-local").click()
  await page.getByTestId("settings-close").click()
  const sent = service.got.length
  await send(page, tools(request(`${service.origin}/echo`)))
  await settled(page)
  await expect(lastCard()).toContainText("did not allow saved secrets there")
  expect(service.got.length).toBe(sent)
  report.push("7. Switch off: the request to 127.0.0.1 was refused with the reason; nothing sent.")

  // The settings part lists the secret, and never shows the value.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  const row = page.getByTestId("saved-secret")
  await expect(row).toHaveCount(1)
  await expect(row).toContainText("test_api")
  await expect(row).toContainText("Ada")
  await expect(row).toContainText(service.origin)
  await expect(row).toContainText("Last used")
  await expect(page.getByTestId("saved-secret-missing")).toHaveCount(0)
  await shot(page, "s41-04-settings-list")
  expect(await page.content()).not.toContain(VALUE)
  report.push(`8. Settings list: ${(await row.textContent()) ?? ""}`)

  // Export: the archive holds no value.
  await page.getByTestId("settings-nav-data").click()
  await page.getByTestId("data-export").click()
  await expect(page.getByTestId("data-note")).toContainText(archive)
  for (const data of Object.values(unzipSync(readFileSync(archive)))) {
    expect(Buffer.from(data).includes(VALUE)).toBe(false)
    expect(Buffer.from(data).includes(b64(VALUE))).toBe(false)
  }
  report.push("9. Export: no clear text and no base64 of the value in the archive.")

  // Delete in settings: the next request fails, and the keychain no longer holds the value.
  const keychainFile = `${userData}-secrets.json`
  expect(readFileSync(keychainFile, "utf8")).toContain(VALUE)
  await page.getByTestId("settings-nav-permissions").click()
  await page.getByTestId("saved-secret-delete").click()
  await page.getByTestId("saved-secret-delete-confirm").click()
  await expect(page.getByTestId("saved-secrets-empty")).toBeVisible()
  expect(readFileSync(keychainFile, "utf8")).not.toContain(VALUE)
  await page.getByTestId("settings-close").click()
  await send(page, tools(request(`${service.origin}/echo`)))
  await settled(page)
  await expect(lastCard()).toContainText("There is no saved secret named test_api")
  report.push("10. Delete in settings: the keychain holds no value; the next request failed.")

  // No file of the app (database, logs, workspace) and no request to the model holds the value.
  await app.close()
  expect(anyFileHolds(userData, VALUE)).toBeNull()
  expect(JSON.stringify(mock.requests)).not.toContain(VALUE)
  expect(JSON.stringify(mock.requests)).not.toContain(b64(VALUE))
  report.push("11. Data folder (database, logs) and every request to the model: no value.")

  // Import into an empty app: the secret shows "Value missing".
  ;({ app, page } = await launch(freshUserData(), { ...env, ROBOT_TEST_OPEN_PATH: archive }))
  await resizeWindow(app, 1300, 900)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-data").click()
  await page.getByTestId("data-restore").click()
  await expect(page.getByTestId("data-note")).toContainText("Restored 1 agents")
  await page.getByTestId("settings-nav-permissions").click()
  await expect(page.getByTestId("saved-secret")).toHaveCount(1)
  await expect(page.getByTestId("saved-secret-missing")).toHaveText("Value missing")
  await shot(page, "s41-05-value-missing")
  report.push("12. Import into an empty app: the secret shows Value missing.")
  await app.close()

  const reports = resolve(shotsDir, "..", "reports")
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, "s41-saved-secrets.md"), `${report.join("\n")}\n`)
  service.close()
  await mock.close()
})
