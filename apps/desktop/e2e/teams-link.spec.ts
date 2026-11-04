import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// The Teams link, first slice (spec 028, S101). The app loads a stand-in site on this computer in
// place of Teams (`ROBOT_TEST_TEAMS_URL`, honoured in a test run only), so the test never reaches
// the real Teams. The stand-in answers to the guessed selectors of
// `src/main/teams/teamsPageSelectors.ts`: if a person fixes those selectors, fix the markers here.

/** A stand-in Teams: a sign-in form until the "user" signs in, then a chat list and a header. */
const startStandIn = async () => {
  const site = { signedIn: false, hits: 0 }
  const chats = ["Marta Kim (You)", "Team A"]
  // The people who wrote in the open chat. "Kim, Tao" shows that a comma is part of a name.
  const messages = [
    { sender: "Joe Lee", text: "hi" },
    { sender: "Marta Kim", text: "hello" },
    { sender: "Kim, Tao", text: "morning" },
    { sender: "Joe Lee", text: "again" },
  ]
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ signedIn: site.signedIn }))
      return
    }
    site.hits++
    res.writeHead(200, { "content-type": "text/html" })
    if (!site.signedIn) {
      // The password field of the stand-in. The page reloads when the user signs in.
      res.end(`<title>Sign in</title><body><form><input type="password" name="passwd"></form>
        <script>setInterval(() => fetch('/state').then(r => r.json()).then(s => { if (s.signedIn) location.reload() }), 400)</script></body>`)
      return
    }
    res.end(`<title>Teams</title><body>
      <div data-tid="app-bar"></div>
      <h2 data-tid="chat-title" id="title">${chats[0]}</h2>
      <div data-tid="message-pane-list-viewport">${messages
        .map(
          (m, i) =>
            `<div data-mid="m${i}"><span data-tid="message-author-name">${m.sender}</span><div data-tid="chat-pane-message-body">${m.text}</div><time datetime="2026-01-01T10:0${i}:00Z"></time></div>`,
        )
        .join("")}</div>
      <div data-tid="chat-list">${chats
        .map(
          (c) =>
            `<div data-tid="chat-list-item" onclick="document.getElementById('title').innerText = this.innerText"><span data-tid="chat-list-item-title">${c}</span></div>`,
        )
        .join("")}</div></body>`)
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { site, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server }
}

const openTeams = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-teams").click()
  await expect(page.getByTestId("teams")).toBeVisible()
}

test("teams link: set up, sign in, pick a chat, turn on, restart in Korean, sign out", async () => {
  test.setTimeout(150_000)
  const stand = await startStandIn()
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US", ROBOT_TEST_TEAMS_URL: stand.url }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1500, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A new profile: the page text shows, the switch is not there yet, and the site saw no visit.
  await openTeams(page)
  await expect(page.getByTestId("teams-facts").locator("li")).toHaveCount(9)
  await expect(page.getByTestId("teams-switch")).toHaveCount(0)
  expect(stand.site.hits).toBe(0)

  // "Set up" shows the form. The switch refuses and gives the reasons under the fields.
  await page.getByTestId("teams-setup").click()
  await expect(page.getByTestId("teams-switch")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("teams-switch").click()
  for (const problem of ["noSignIn", "noTarget", "titleEmpty", "allowEmpty"])
    await expect(page.getByTestId(`teams-problem-${problem}`)).toBeVisible()
  await expect(page.getByTestId("teams-on-dialog")).toHaveCount(0)
  await expect(page.getByTestId("teams-switch")).toHaveAttribute("aria-checked", "false")
  expect(stand.site.hits).toBe(0)

  // "Sign in to Teams" shows the Teams page. The site shows a sign-in form.
  await page.getByTestId("teams-signin-button").click()
  await expect(page.getByTestId("teams-page-box")).toBeVisible()
  await expect(page.getByTestId("teams-signin-state")).toHaveText("Not signed in")
  await expect.poll(() => stand.site.hits).toBeGreaterThan(0)
  // The user signs in by hand in the page. The app sees Teams.
  stand.site.signedIn = true
  await expect(page.getByTestId("teams-signin-state")).toHaveText("Signed in to Teams", {
    timeout: 20_000,
  })
  await page.getByTestId("teams-page-toggle").click()
  await expect(page.getByTestId("teams-page-box")).toHaveCount(0)

  // The sign-in profile is listed in Settings, Browser with no rename and no delete.
  await page.getByTestId("settings-nav-browser").click()
  await expect(page.getByTestId("browser-profile-teams")).toHaveText("Used by the Teams link")
  await expect(page.getByTestId("browser-profile-rename")).toHaveCount(0)
  await expect(page.getByTestId("browser-profile-delete")).toHaveCount(0)
  // The field "Browser profile" of an agent does not list it.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("settings")).toHaveCount(0)
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-browser-profile").locator("option")).toHaveText([
    "Only this agent",
  ])
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)

  // The form: the target, the chat that is open in the page, and the allowed sender.
  await openTeams(page)
  await page.getByTestId("teams-target-pick").selectOption({ label: "Ada" })
  await page.getByTestId("teams-signin-button").click()
  await expect(page.getByTestId("teams-page-box")).toBeVisible()
  await page.getByTestId("teams-use-chat").click()
  await expect(page.getByTestId("teams-chat-title")).toHaveValue("Marta Kim (You)")

  // "Find in the chat" reads the senders of the open chat, each once. It adds none by itself.
  await expect(page.getByTestId("teams-allow-chip")).toHaveCount(0)
  await page.getByTestId("teams-allow-find").click()
  await expect(page.getByTestId("teams-allow-suggestion")).toHaveText([
    "Joe Lee",
    "Marta Kim",
    "Kim, Tao",
  ])
  await expect(page.getByTestId("teams-allow-chip")).toHaveCount(0)
  await shot(page, "teams-names-found")
  // A press on a name adds it, and the name leaves the offer. A comma stays in the name.
  await page.getByTestId("teams-allow-suggestion").filter({ hasText: "Marta Kim" }).click()
  await expect(page.getByTestId("teams-allow-chip")).toHaveText(["Marta Kim"])
  await expect(page.getByTestId("teams-allow-suggestion")).toHaveText(["Joe Lee", "Kim, Tao"])
  // The bot list is the same control. "Add all" takes every name that is left.
  await page.getByTestId("teams-bots-find").click()
  await expect(page.getByTestId("teams-bots-suggestion")).toHaveCount(3)
  await page.getByTestId("teams-bots-add-all").click()
  await expect(page.getByTestId("teams-bots-chip")).toHaveText(["Joe Lee", "Marta Kim", "Kim, Tao"])
  await expect(page.getByTestId("teams-bots-found-none")).toBeVisible()
  await expect(page.getByTestId("teams-bot-wins")).toBeVisible()
  await shot(page, "teams-names-lists")
  await page.getByTestId("teams-page-toggle").click()
  // With the page closed, the button says what to do first, and the lists stay as they are.
  await page.getByTestId("teams-allow-find").click()
  await expect(page.getByTestId("teams-allow-find-error")).toContainText(
    "Show the Teams page and open the chat first.",
  )

  // The cross on a chip removes the name. Backspace in the empty box removes the last name.
  await page
    .getByTestId("teams-bots-chip")
    .filter({ hasText: "Joe Lee" })
    .getByRole("button")
    .click()
  await page.getByTestId("teams-bots").click()
  await page.keyboard.press("Backspace")
  await page.keyboard.press("Backspace")
  await expect(page.getByTestId("teams-bots-chip")).toHaveCount(0)
  await expect(page.getByTestId("teams-bot-wins")).toHaveCount(0)
  // A name that is typed joins with Enter. A name that is on the list is not added twice.
  await page.getByTestId("teams-allow").fill("marta  KIM")
  await page.getByTestId("teams-allow").press("Enter")
  await page.getByTestId("teams-allow").fill("Joe Lee")
  await page.getByTestId("teams-allow").press("Enter")
  await expect(page.getByTestId("teams-allow-chip")).toHaveText(["Marta Kim", "Joe Lee"])
  await expect(page.getByTestId("teams-allow")).toHaveValue("")
  await page
    .getByTestId("teams-allow-chip")
    .filter({ hasText: "Joe Lee" })
    .getByRole("button")
    .click()
  await expect(page.getByTestId("teams-allow-chip")).toHaveText(["Marta Kim"])
  await page.getByTestId("teams-call").click()

  // The switch shows a dialog; "Back" leaves it off; "Turn on" starts the link.
  await page.getByTestId("teams-switch").click()
  await expect(page.getByTestId("teams-on-dialog")).toBeVisible()
  await expect(page.getByTestId("teams-on-facts").locator("li")).toHaveCount(3)
  await page.getByTestId("teams-on-back").click()
  await expect(page.getByTestId("teams-on-dialog")).toHaveCount(0)
  await expect(page.getByTestId("teams-switch")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("teams-switch").click()
  await page.getByTestId("teams-on-confirm").click()
  await expect(page.getByTestId("teams-switch")).toHaveAttribute("aria-checked", "true")
  await expect(page.getByTestId("teams-state")).toContainText(
    "Reading Marta Kim (You). Last read",
    {
      timeout: 20_000,
    },
  )
  // The target, title, kind and marker are locked while the switch is on.
  await expect(page.getByTestId("teams-chat-title")).toBeDisabled()
  await expect(page.getByTestId("teams-marker")).toBeDisabled()
  await expect(page.getByTestId("teams-allow")).toBeEnabled()

  // The header of the agent has the mark.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("settings")).toHaveCount(0)
  await expect(page.getByTestId("teams-mark")).toContainText("Linked to Teams")
  await expect(page.getByTestId("teams-mark-state")).toHaveCount(0)

  // The app stops. The next start comes back with the link on, in Korean.
  await app.close()
  const second = await launch(userData, { ...env, ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(second.app, 1500, 1000)
  await second.page.getByTestId("open-settings").click()
  await second.page.getByTestId("settings-nav-teams").click()
  await expect(second.page.getByTestId("teams-switch")).toHaveAttribute("aria-checked", "true")
  await expect(second.page.getByTestId("teams-state")).toContainText("채팅을 읽는 중", {
    timeout: 25_000,
  })
  await expect(second.page.getByTestId("teams-facts").locator("li").first()).toContainText(
    "Microsoft Teams 채팅으로",
  )

  // "Sign out of Teams" asks first, deletes the sign-in, and turns the link off.
  await second.page.getByTestId("teams-signout").click()
  await second.page.getByTestId("teams-signout-confirm").click()
  await expect(second.page.getByTestId("teams-switch")).toHaveAttribute("aria-checked", "false")
  await expect(second.page.getByTestId("teams-signin-state")).toHaveText("로그인하지 않았어요")
  await expect(second.page.getByTestId("teams-state")).toHaveText("꺼짐")
  await second.app.close()
  stand.server.close()
  await mock.close()
})
