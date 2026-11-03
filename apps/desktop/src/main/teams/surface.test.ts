import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { FakeChat } from "./fakeChat.testing.ts"
import {
  clickChatScript,
  createTeamsSurface,
  interpretRead,
  isOfflineError,
  isSignInAddress,
  type RawTeamsRead,
  readScript,
} from "./surface.ts"
import { TEAMS_PAGE } from "./teamsPageSelectors.ts"

const raw = (over: Partial<RawTeamsRead> = {}): RawTeamsRead => ({
  url: "https://teams.cloud.microsoft/",
  online: true,
  signInForm: false,
  shell: true,
  openTitle: null,
  chatTitles: [],
  ...over,
})

describe("what a read of the page says", () => {
  test("the app shows Teams, with the title of the open chat", () => {
    expect(interpretRead(raw({ openTitle: "Marta Kim (You)" }))).toEqual({
      kind: "teams",
      openTitle: "Marta Kim (You)",
    })
    expect(interpretRead(raw())).toEqual({ kind: "teams", openTitle: null })
  })

  test("a sign-in form, or a page of the Microsoft sign-in, is a sign-in", () => {
    expect(interpretRead(raw({ shell: false, signInForm: true }))).toEqual({ kind: "signIn" })
    expect(
      interpretRead(raw({ shell: false, url: "https://login.microsoftonline.com/common/oauth2" })),
    ).toEqual({ kind: "signIn" })
    // A sign-in form comes before the app.
    expect(interpretRead(raw({ signInForm: true }))).toEqual({ kind: "signIn" })
  })

  test("a page without a network, or an error page, is offline", () => {
    expect(interpretRead(raw({ online: false }))).toEqual({ kind: "offline" })
    expect(interpretRead(raw({ url: "chrome-error://chromewebdata/", shell: false }))).toEqual({
      kind: "offline",
    })
  })

  test("a page with neither the app nor a form cannot be read", () => {
    expect(interpretRead(raw({ shell: false }))).toEqual({ kind: "unreadable" })
  })

  test("the hosts of the sign-in", () => {
    expect(isSignInAddress("https://login.microsoftonline.com/x")).toBe(true)
    expect(isSignInAddress("https://sub.login.live.com/x")).toBe(true)
    expect(isSignInAddress("https://teams.cloud.microsoft/")).toBe(false)
    expect(isSignInAddress("https://evil-login.microsoftonline.com.example.com/")).toBe(false)
    expect(isSignInAddress("not an address")).toBe(false)
  })

  test("only a network failure of a load is an offline page", () => {
    expect(isOfflineError(new Error("ERR_INTERNET_DISCONNECTED (-106)"))).toBe(true)
    expect(isOfflineError(new Error("ERR_NAME_NOT_RESOLVED"))).toBe(true)
    expect(isOfflineError("ERR_CONNECTION_TIMED_OUT")).toBe(true)
    expect(isOfflineError(new Error("ERR_ABORTED (-3)"))).toBe(false)
    expect(isOfflineError(new Error("something else"))).toBe(false)
  })
})

describe("the scripts", () => {
  test("they hold the selectors of the selectors module, and nothing else of the page", () => {
    expect(readScript()).toContain(JSON.stringify(TEAMS_PAGE))
    expect(clickChatScript(0)).toContain(JSON.stringify(TEAMS_PAGE))
  })

  test("a click script takes a whole number", () => {
    expect(clickChatScript(2.9)).toContain("items[2]")
  })

  test("every selector of the Teams page is in one file", () => {
    const here = import.meta.dir
    const hits = readdirSync(here)
      .filter((f) => f.endsWith(".ts") && f !== "teamsPageSelectors.ts")
      .filter((f) =>
        /data-tid|role="treeitem"|input\[type=/.test(readFileSync(join(here, f), "utf8")),
      )
    // This test file names the markers in its own check; the other files must not.
    expect(hits.filter((f) => f !== "surface.test.ts")).toEqual([])
  })
})

describe("the surface on the stand-in Teams", () => {
  const surface = (chat: FakeChat) => chat.surface

  test("a new stand-in has seen no visit", () => {
    const chat = new FakeChat()
    expect(chat.visits).toBe(0)
    expect(chat.evaluations).toBe(0)
    expect(surface(chat).isOpen()).toBe(false)
  })

  test("a look loads Teams once and shows a sign-in form to a user who is not signed in", async () => {
    const chat = new FakeChat()
    expect(await surface(chat).look()).toEqual({ kind: "signIn" })
    expect(chat.loads).toEqual([TEAMS_PAGE.url])
    await surface(chat).look()
    expect(chat.visits).toBe(1)
  })

  test("after the user signs in by hand the page shows Teams", async () => {
    const chat = new FakeChat()
    chat.addChat("Marta Kim (You)")
    await surface(chat).look()
    chat.signInByHand("a password")
    expect(await surface(chat).look()).toEqual({ kind: "teams", openTitle: null })
    chat.openByUser("Marta Kim (You)")
    expect(await surface(chat).look()).toEqual({ kind: "teams", openTitle: "Marta Kim (You)" })
  })

  test("a dropped network is offline, and the next look loads the page again", async () => {
    const chat = new FakeChat()
    chat.signedIn = true
    chat.dropNetwork()
    expect(await surface(chat).look()).toEqual({ kind: "offline" })
    expect(await surface(chat).look()).toEqual({ kind: "offline" })
    expect(chat.visits).toBe(2)
    chat.restoreNetwork()
    expect(await surface(chat).look()).toEqual({ kind: "teams", openTitle: null })
    expect(chat.visits).toBe(3)
  })

  test("a network that drops after the page loaded is offline too", async () => {
    const chat = new FakeChat()
    chat.signedIn = true
    await surface(chat).look()
    chat.dropNetwork()
    expect(await surface(chat).look()).toEqual({ kind: "offline" })
  })

  test("a page that Teams changed cannot be read, and a failed script is the same", async () => {
    const chat = new FakeChat()
    chat.signedIn = true
    await surface(chat).look()
    chat.breakPage()
    expect(await surface(chat).look()).toEqual({ kind: "unreadable" })
    chat.breakPage(false)
    chat.failScripts(1)
    expect(await surface(chat).look()).toEqual({ kind: "unreadable" })
    expect(await surface(chat).look()).toEqual({ kind: "teams", openTitle: null })
  })

  test("it opens the one chat that holds the title", async () => {
    const chat = new FakeChat()
    chat.signedIn = true
    chat.addChat("Team A")
    chat.addChat("Marta Kim (You)")
    await surface(chat).look()
    expect(await surface(chat).openChat("(you)")).toEqual({
      kind: "opened",
      title: "Marta Kim (You)",
    })
    expect(chat.openIndex).toBe(1)
    // The chat is open already: a second call clicks nothing and gives the same answer.
    expect(await surface(chat).openChat("(you)")).toEqual({
      kind: "opened",
      title: "Marta Kim (You)",
    })
  })

  test("no chat, or more than one chat, holds the title: nothing is opened", async () => {
    const chat = new FakeChat()
    chat.signedIn = true
    chat.addChat("Team A")
    chat.addChat("Team A")
    await surface(chat).look()
    expect(await surface(chat).openChat("Team A")).toEqual({ kind: "many" })
    expect(await surface(chat).openChat("Project X")).toEqual({ kind: "none" })
    expect(chat.openIndex).toBeNull()
    // The surface has no way to type, and the stand-in saw no typing or message read.
    expect(chat.typed).toEqual([])
    expect(chat.messageReads).toBe(0)
  })

  test("a chat that does not open in time is a failure, not a match", async () => {
    const chat = new FakeChat()
    chat.signedIn = true
    chat.addChat("Team A")
    // A stand-in whose rows do nothing when they are clicked.
    const stuck = createTeamsSurface(
      {
        ...chat.driver,
        evaluate: async <T>(code: string) =>
          (code.includes(".click()") ? false : await chat.driver.evaluate<T>(code)) as T,
      },
      { wait: async () => {} },
    )
    await stuck.look()
    await expect(stuck.openChat("Team A")).rejects.toThrow()
  })

  test("place, input and close reach the page", async () => {
    const chat = new FakeChat()
    chat.signedIn = true
    await surface(chat).look()
    surface(chat).place({ x: 1, y: 2, width: 3, height: 4 })
    surface(chat).allowUserInput(true)
    expect(chat.placed).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(chat.inputAllowed).toBe(true)
    surface(chat).close()
    expect(chat.isOpen).toBe(false)
    expect(chat.placed).toBeUndefined()
  })
})
