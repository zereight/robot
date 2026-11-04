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
  isTeamsAddress,
  type RawTeamsRead,
  readScript,
  sendScript,
} from "./surface.ts"
import { TEAMS_PAGE } from "./teamsPageSelectors.ts"

const raw = (over: Partial<RawTeamsRead> = {}): RawTeamsRead => ({
  url: "https://teams.cloud.microsoft/",
  online: true,
  signInForm: false,
  shell: true,
  landmarks: false,
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

  test("a signed-in Teams page whose shell selector does not match still shows Teams", () => {
    // The selector of the shell is a guess. The Teams host with the regions of a loaded app is
    // the app, with the title of the open chat when the page has one.
    expect(interpretRead(raw({ shell: false, landmarks: true, openTitle: "Marta" }))).toEqual({
      kind: "teams",
      openTitle: "Marta",
    })
    // The regions on a page of another host prove nothing.
    expect(
      interpretRead(raw({ shell: false, landmarks: true, url: "https://example.com/" })),
    ).toEqual({ kind: "unreadable" })
    // A sign-in form, or a sign-in host, still wins over the regions.
    expect(interpretRead(raw({ shell: false, landmarks: true, signInForm: true }))).toEqual({
      kind: "signIn",
    })
    expect(
      interpretRead(
        raw({ shell: false, landmarks: true, url: "https://login.microsoftonline.com/x" }),
      ),
    ).toEqual({ kind: "signIn" })
  })

  test("the hosts of the Teams app", () => {
    expect(isTeamsAddress("https://teams.cloud.microsoft/v2/")).toBe(true)
    expect(isTeamsAddress("https://teams.microsoft.com/")).toBe(true)
    expect(isTeamsAddress("https://x.teams.microsoft.com/")).toBe(true)
    expect(isTeamsAddress("https://teams.microsoft.com.example.com/")).toBe(false)
    expect(isTeamsAddress("https://login.microsoftonline.com/")).toBe(false)
    expect(isTeamsAddress("not an address")).toBe(false)
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

describe("the read of the messages of the open chat (S102)", () => {
  const surface = (chat: FakeChat) => chat.surface
  const room = async (chat: FakeChat) => {
    chat.signedIn = true
    chat.addChat("Team A")
    chat.addChat("Team B")
    await surface(chat).look()
    await surface(chat).openChat("Team A")
  }

  test("gives the title of the open chat and its messages in the order that the chat shows", async () => {
    const chat = new FakeChat()
    await room(chat)
    const one = chat.say("Team A", "Marta Kim", "first", 1_700_000_000_000)
    chat.say("Team A", "Joe Lee", "second", 1_700_000_060_000)
    chat.say("Team B", "Marta Kim", "in the other chat", 1_700_000_090_000)
    chat.type("[ROBot] typed by the app")
    const read = await surface(chat).readMessages()
    expect(read.openTitle).toBe("Team A")
    expect(read.messages.map((m) => [m.sender, m.text, m.time, m.own])).toEqual([
      ["Marta Kim", "first", 1_700_000_000_000, false],
      ["Joe Lee", "second", 1_700_000_060_000, false],
      ["Marta Kim", "[ROBot] typed by the app", expect.any(Number), true],
    ])
    expect(read.messages[0]?.id).toBe(one.id)
    expect(chat.messageReads).toBe(1)
  })

  test("an edit keeps the identity, a delete removes the message, a reload shows no open chat", async () => {
    const chat = new FakeChat()
    await room(chat)
    const message = chat.say("Team A", "Marta Kim", "before")
    chat.edit(message, "after")
    const read = await surface(chat).readMessages()
    expect(read.messages.map((m) => [m.id, m.text])).toEqual([[message.id, "after"]])
    chat.remove(message)
    expect((await surface(chat).readMessages()).messages).toEqual([])
    chat.reload()
    expect((await surface(chat).readMessages()).openTitle).toBeNull()
  })

  test("a page that gives no identity and no sender gives null and an empty name", async () => {
    const chat = new FakeChat()
    await room(chat)
    chat.identities = false
    chat.say("Team A", "", "a card alone")
    const [message] = (await surface(chat).readMessages()).messages
    expect(message).toMatchObject({ id: null, sender: "", text: "a card alone" })
  })

  test("a page that cannot be read fails the read, and the read types nothing", async () => {
    const chat = new FakeChat()
    await room(chat)
    chat.failScripts(1)
    await expect(surface(chat).readMessages()).rejects.toThrow()
    expect(chat.typed).toEqual([])
  })

  test("the stand-in accepts a typed message only in an open chat", () => {
    const chat = new FakeChat()
    chat.addChat("Team A")
    expect(() => chat.type("hello")).toThrow()
  })
})

describe("typing and sending (S103)", () => {
  const room = async (chat: FakeChat) => {
    chat.signedIn = true
    chat.addChat("Team A")
    chat.addChat("Team B")
    await chat.surface.look()
    await chat.surface.openChat("Team A")
  }

  test("types the text into the open chat and sends it: the stand-in gets one message", async () => {
    const chat = new FakeChat()
    await room(chat)
    expect(await chat.surface.send("[ROBot] hello", "Team A")).toEqual({ kind: "sent" })
    expect(chat.typed).toEqual([{ chat: "Team A", text: "[ROBot] hello" }])
    expect(chat.sendTries).toBe(1)
    // The page took the text out of the box.
    expect(chat.composerText).toBe("")
    expect((await chat.surface.readMessages()).messages.map((m) => [m.text, m.own])).toEqual([
      ["[ROBot] hello", true],
    ])
  })

  test("a text of several lines goes as one message, with its line breaks", async () => {
    const chat = new FakeChat()
    await room(chat)
    await chat.surface.send("[ROBot] one\ntwo\n\nthree", "Team A")
    expect(chat.typed.map((t) => t.text)).toEqual(["[ROBot] one\ntwo\n\nthree"])
  })

  test("the chat is opened when no chat is open, and then the text goes", async () => {
    const chat = new FakeChat()
    await room(chat)
    chat.reload()
    expect((await chat.surface.readMessages()).openTitle).toBeNull()
    expect(await chat.surface.send("[ROBot] after a reload", "Team A")).toEqual({ kind: "sent" })
    expect(chat.typed).toEqual([{ chat: "Team A", text: "[ROBot] after a reload" }])
  })

  test("the compare of the title is the one of the link: spaces and letter case do not count", async () => {
    const chat = new FakeChat()
    chat.signedIn = true
    chat.addChat("Marta Kim (You)")
    await chat.surface.look()
    await chat.surface.openChat("marta   KIM")
    expect(await chat.surface.send("[ROBot] x", "  marta   kim ")).toEqual({ kind: "sent" })
  })

  test("a chat with another title gets no text: nothing is typed and the box stays empty", async () => {
    const chat = new FakeChat()
    await room(chat)
    chat.openByUser("Team B")
    expect(await chat.surface.send("[ROBot] for A", "Team A")).toEqual({ kind: "wrongChat" })
    expect(chat.typed).toEqual([])
    expect(chat.sendTries).toBe(0)
    expect(chat.composerText).toBe("")
  })

  test("a header that shows a wrong title gets no text either", async () => {
    const chat = new FakeChat()
    await room(chat)
    chat.headerTitle = "Somebody else"
    expect(await chat.surface.send("[ROBot] x", "Team A")).toEqual({ kind: "wrongChat" })
    expect(chat.typed).toEqual([])
    expect(chat.composerText).toBe("")
  })

  test("an empty chat title in the link holds no chat: nothing is typed", async () => {
    const chat = new FakeChat()
    await room(chat)
    expect(await chat.surface.send("[ROBot] x", "   ")).toEqual({ kind: "wrongChat" })
    expect(chat.typed).toEqual([])
  })

  test("a send that the page refuses is a failed try, and the box is cleared for the next try", async () => {
    const chat = new FakeChat()
    await room(chat)
    chat.refuseSends(1)
    expect(await chat.surface.send("[ROBot] first", "Team A")).toEqual({ kind: "failed" })
    expect(chat.typed).toEqual([])
    // The refused text did not stay in the box: the next try sends one text, not two.
    expect(chat.composerText).toBe("")
    expect(await chat.surface.send("[ROBot] first", "Team A")).toEqual({ kind: "sent" })
    expect(chat.typed).toEqual([{ chat: "Team A", text: "[ROBot] first" }])
    expect(chat.sendTries).toBe(2)
  })

  test("a page that cannot be read, or that has no network, is a failed try and types nothing", async () => {
    const chat = new FakeChat()
    await room(chat)
    chat.failScripts(1)
    expect(await chat.surface.send("[ROBot] x", "Team A")).toEqual({ kind: "failed" })
    chat.dropNetwork()
    expect(await chat.surface.send("[ROBot] x", "Team A")).toEqual({ kind: "failed" })
    expect(chat.typed).toEqual([])
    expect(chat.sendTries).toBe(0)
  })

  test("no chat that holds the title, or two that do, is a failed try", async () => {
    const chat = new FakeChat()
    await room(chat)
    chat.reload()
    expect(await chat.surface.send("[ROBot] x", "No such chat")).toEqual({ kind: "failed" })
    chat.addChat("Team A again")
    chat.reload()
    expect(await chat.surface.send("[ROBot] x", "Team A")).toEqual({ kind: "failed" })
    expect(chat.typed).toEqual([])
  })

  test("the send script holds no selector of its own: it takes them from the selectors module", () => {
    const code = sendScript("x", "team a")
    expect(code).toContain(JSON.stringify(TEAMS_PAGE.messageBox))
    expect(code).toContain(JSON.stringify(TEAMS_PAGE.sendButton))
    // The text of the message is data inside the script, not part of its code.
    expect(sendScript('"; alert(1); "', "team a")).toContain(JSON.stringify('"; alert(1); "'))
  })
})
