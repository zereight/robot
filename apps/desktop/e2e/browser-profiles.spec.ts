import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

const rowNamed = (page: Page, name: string) =>
  page
    .getByTestId("section-agents")
    .locator("[data-place-row]")
    .filter({ hasText: new RegExp(`^${name}$`) })

const openProfile = async (page: Page, name: string) => {
  await rowNamed(page, name).click()
  await expect(page.getByTestId("chat-start").locator("h2")).toHaveText(name)
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}

const closeDialog = async (page: Page, testId: string) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId(testId)).toHaveCount(0)
}

const openBrowserSettings = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-browser").click()
  await expect(page.getByTestId("browser-profiles")).toBeVisible()
}

const addProfile = async (page: Page, name: string) => {
  await page.getByTestId("browser-profile-add").click()
  await page.getByTestId("browser-profile-name").fill(name)
  await page.getByTestId("browser-profile-save").click()
}

const profileRow = (page: Page, name: string) =>
  page.locator(`[data-testid="browser-profile"][data-name="${name}"]`)

test("browser profiles: make them, give them to agents, share a sign-in, delete one", async () => {
  test.setTimeout(150_000)
  // A site that signs the browser in at /login with a cookie, and shows the cookie it gets.
  const site = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/login")
      res.setHeader("set-cookie", "sid=abc; Path=/; Max-Age=3600; SameSite=Lax")
    res.writeHead(200, { "content-type": "text/html" })
    res.end(
      `<title>Test site</title><body><h1>COOKIE[${req.headers.cookie ?? "none"}] n=${url.searchParams.get("n") ?? "0"}</h1></body>`,
    )
  })
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)

  /** Opens a page in the browser of the open agent and reads it. */
  const visit = async (path: string, expected: string) => {
    await send(page, `TOOL browser_open ${JSON.stringify({ url: `${base}${path}` })}`)
    await expect(page.getByTestId("browser-card")).toBeVisible({ timeout: 15_000 })
    await send(page, "TOOL browser_read {}")
    await expect(page.getByTestId("message").last()).toContainText(expected, { timeout: 15_000 })
  }

  // Settings, Browser: nothing yet. Make two profiles. A name that is taken gives a plain error.
  await openBrowserSettings(page)
  await expect(page.getByTestId("browser-profiles-empty")).toBeVisible()
  await addProfile(page, "Work")
  await expect(profileRow(page, "Work")).toBeVisible()
  await expect(profileRow(page, "Work").getByTestId("browser-profile-users")).toHaveText(
    "No agent uses it.",
  )
  await addProfile(page, " work ")
  await expect(page.getByTestId("browser-profile-error")).toHaveText(
    "Another browser profile has this name.",
  )
  await page.getByTestId("browser-profile-name").fill("Home")
  await page.getByTestId("browser-profile-save").click()
  await expect(profileRow(page, "Home")).toBeVisible()
  await expect(page.getByTestId("browser-profile-dialog")).toHaveCount(0)
  await shot(page, "browser-profiles-01-settings")
  await page.getByTestId("settings-close").click()

  // Ada and Bo get "Work". Cy keeps its own data.
  for (const name of ["Ada", "Bo"]) {
    await openProfile(page, name)
    await expect(page.getByTestId("agent-browser-profile")).toHaveValue("")
    await page.getByTestId("agent-browser-profile").selectOption({ label: "Work" })
    await expect(page.getByTestId("agent-browser-profile-error")).toHaveCount(0)
    await shot(page, `browser-profiles-02-${name.toLowerCase()}`)
    await closeDialog(page, "agent-profile")
  }

  // Ada signs in. Bo, who shares the profile, is signed in too. Cy, who has its own data, is not.
  await rowNamed(page, "Ada").click()
  await send(page, `TOOL browser_open ${JSON.stringify({ url: `${base}/login?n=1` })}`)
  await expect(page.getByTestId("browser-card")).toBeVisible({ timeout: 15_000 })
  await visit("/?n=2", "COOKIE[sid=abc] n=2")
  await rowNamed(page, "Bo").click()
  await visit("/?n=3", "COOKIE[sid=abc] n=3")
  await rowNamed(page, "Cy").click()
  await visit("/?n=4", "COOKIE[none] n=4")
  await shot(page, "browser-profiles-03-cy-not-signed-in")

  // Settings names the agents that use each profile.
  await openBrowserSettings(page)
  const users = profileRow(page, "Work").getByTestId("browser-profile-users")
  await expect(users).toContainText("Ada")
  await expect(users).toContainText("Bo")
  await expect(profileRow(page, "Home").getByTestId("browser-profile-users")).toHaveText(
    "No agent uses it.",
  )
  await page.getByTestId("settings-close").click()

  // Ada goes back to her own data: her open page closes, and she is not signed in any more.
  await openProfile(page, "Ada")
  await expect(page.getByTestId("agent-browser-profile")).toHaveValue(/.+/)
  await page.getByTestId("agent-browser-profile").selectOption({ label: "Only this agent" })
  await closeDialog(page, "agent-profile")
  await expect(page.getByTestId("browser-card")).toHaveCount(0)
  await visit("/?n=5", "COOKIE[none] n=5")

  // Delete "Work". Bo goes back to his own data, which has no sign-in.
  await openBrowserSettings(page)
  await profileRow(page, "Work").getByTestId("browser-profile-delete").click()
  await expect(page.getByTestId("browser-profile-delete-dialog")).toBeVisible()
  await shot(page, "browser-profiles-04-delete")
  await page.getByTestId("browser-profile-delete-confirm").click()
  await expect(profileRow(page, "Work")).toHaveCount(0)
  await expect(profileRow(page, "Home")).toBeVisible()
  await page.getByTestId("settings-close").click()
  await openProfile(page, "Bo")
  await expect(page.getByTestId("agent-browser-profile")).toHaveValue("")
  await closeDialog(page, "agent-profile")
  await visit("/?n=6", "COOKIE[none] n=6")

  await app.close()
  site.close()
})
