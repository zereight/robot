import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  SYNC_KINDS,
  TEAMS_CONNECT_MAX_MS,
  TEAMS_LOOK_AGAIN_MS,
  type TeamsPatch,
} from "@robot/shared"
import { Effect, Exit, ManagedRuntime } from "effect"
import { unzipSync } from "fflate"
import { appLayer } from "../layers.ts"
import { FakeChat } from "../teams/fakeChat.testing.ts"
import { Agents } from "./Agents.ts"
import { BrowserProfiles } from "./BrowserProfiles.ts"
import { Channels } from "./Channels.ts"
import { Data } from "./Data.ts"
import { Database } from "./Database.ts"
import { Secrets } from "./Secrets.ts"
import { Servers } from "./Servers.ts"
import { TeamsLink } from "./TeamsLink.ts"
import { testPlatform, testRuntime } from "./testing.ts"

const CHAT = "Marta Kim (You)"
const PASSWORD = "correct-horse-battery-staple-7731"

/** Lets the work that waits on a promise run. The stand-in answers at once, so a few turns do. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

const failCode = (exit: Exit.Exit<unknown, { code: string }>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((r) => ("error" in r ? (r.error as { code: string }).code : "")).join()
    : "ok"

const setup = async () => {
  const t = testRuntime({ name: "This Mac" })
  const run = t.runtime.runPromise
  const exit = t.runtime.runPromiseExit
  const server = await run(Servers.use((s) => s.local))
  const agent = (name: string) =>
    run(Agents.use((a) => a.create({ serverId: server.id, name, role: "", instructions: "" })))
  const view = () => run(TeamsLink.use((l) => l.view))
  const setupLink = () => run(TeamsLink.use((l) => l.setup))
  const update = (patch: TeamsPatch) => run(TeamsLink.use((l) => l.update(patch)))
  const turnOn = () => run(TeamsLink.use((l) => l.setEnabled(true)))
  const turnOff = () => run(TeamsLink.use((l) => l.setEnabled(false)))
  const showPage = () => run(TeamsLink.use((l) => l.showPage))
  const hidePage = () => run(TeamsLink.use((l) => l.hidePage))
  /** Moves time on one second at a time, and lets the work of each second finish. */
  const pass = async (ms: number) => {
    for (let spent = 0; spent < ms; spent += 1000) {
      t.advance(1000)
      await settle()
    }
  }
  /** Fills the form so that only the sign-in can be missing. */
  const fill = async (over: TeamsPatch = {}) => {
    const a = await agent("Ada")
    await update({
      targetKind: "agent",
      targetId: a.id,
      chatTitle: "(You)",
      allow: ["Marta Kim"],
      ...over,
    })
    return a
  }
  /** The whole way a user takes: set up, sign in by hand, fill the form. */
  const prepare = async (over: TeamsPatch = {}) => {
    await setupLink()
    t.chat.addChat(CHAT)
    await showPage()
    t.chat.signInByHand(PASSWORD)
    await pass(3000)
    const a = await fill(over)
    return a
  }
  return {
    ...t,
    run,
    exit,
    server,
    agent,
    view,
    setupLink,
    update,
    turnOn,
    turnOff,
    showPage,
    hidePage,
    pass,
    fill,
    prepare,
  }
}

type T = Awaited<ReturnType<typeof setup>>
const dispose = (t: T) => t.runtime.dispose()

/** An app where the user set up the link, signed in and filled the form. The switch is off. */
const ready = async (over: TeamsPatch = {}) => {
  const t = await setup()
  await t.prepare(over)
  return t
}

describe("a new profile", () => {
  test("the switch is off, there is no link, and the stand-in saw no visit", async () => {
    const t = await setup()
    const v = await t.view()
    expect(v.exists).toBe(false)
    expect(v.enabled).toBe(false)
    expect(v.state).toBe("off")
    expect(v.signInProfileId).toBeNull()
    // Time goes on: nothing opens the Teams page.
    await t.pass(120_000)
    expect(t.chat.visits).toBe(0)
    expect(t.chat.evaluations).toBe(0)
    expect(await t.run(BrowserProfiles.use((b) => b.list))).toEqual([])
    await dispose(t)
  })

  test("'Set up' makes the link with an empty form, and the stand-in still saw no visit", async () => {
    const t = await setup()
    const v = await t.setupLink()
    expect(v.exists).toBe(true)
    expect(v.enabled).toBe(false)
    expect(v.fields).toMatchObject({
      targetKind: null,
      chatTitle: "",
      chatKind: "person",
      allow: [],
      bots: [],
      callText: "",
      marker: "[ROBot]",
    })
    expect(t.chat.visits).toBe(0)
    // A second press changes nothing.
    await t.update({ chatTitle: "Kept" })
    expect((await t.setupLink()).fields.chatTitle).toBe("Kept")
    await dispose(t)
  })

  test("a call before 'Set up' is refused", async () => {
    const t = await setup()
    expect(failCode(await t.exit(TeamsLink.use((l) => l.update({ chatTitle: "x" }))))).toBe(
      "teams_not_set_up",
    )
    expect(failCode(await t.exit(TeamsLink.use((l) => l.showPage)))).toBe("teams_not_set_up")
    await dispose(t)
  })
})

describe("the switch and its checks", () => {
  test("the switch stays off, with a reason, while something is missing; the stand-in sees no visit", async () => {
    const t = await setup()
    await t.setupLink()
    const refused = await t.turnOn()
    expect(refused.enabled).toBe(false)
    expect(refused.state).toBe("off")
    expect(refused.problems).toEqual(["noSignIn", "noTarget", "titleEmpty", "allowEmpty"])
    expect(t.chat.visits).toBe(0)
    await dispose(t)
  })

  test("each missing part is its own reason", async () => {
    const t = await ready()
    await t.update({ chatTitle: "" })
    expect((await t.turnOn()).problems).toEqual(["titleEmpty"])
    await t.update({ chatTitle: "(You)", allow: [] })
    expect((await t.turnOn()).problems).toEqual(["allowEmpty"])
    await t.update({ allow: ["Marta Kim"], chatKind: "group" })
    expect((await t.turnOn()).problems).toEqual(["callMissing"])
    await t.update({ callText: "@ROBot" })
    expect((await t.turnOn()).enabled).toBe(true)
    await dispose(t)
  })

  test("a text over its limit is a reason, and the form keeps the text", async () => {
    const t = await ready()
    await t.update({ chatTitle: "t".repeat(101), callText: "c".repeat(41), marker: "m".repeat(21) })
    const v = await t.turnOn()
    expect(v.enabled).toBe(false)
    expect(v.problems).toEqual(["titleLong", "callLong", "markerLong"])
    expect(v.fields.chatTitle).toHaveLength(101)
    await t.update({ allow: Array.from({ length: 21 }, (_, i) => `Person ${i}`) })
    expect((await t.turnOn()).problems).toContain("allowMany")
    await dispose(t)
  })

  test("a name on both lists is kept; the bot list wins and the view says so", async () => {
    const t = await ready({ bots: ["marta  kim"] })
    const v = await t.view()
    expect(v.fields.allow).toEqual(["Marta Kim"])
    expect(v.fields.bots).toEqual(["marta kim"])
    expect(v.botListWins).toBe(true)
    expect(v.problems).toEqual([])
    await dispose(t)
  })

  test("a target that does not exist is refused", async () => {
    const t = await ready()
    expect(
      failCode(
        await t.exit(TeamsLink.use((l) => l.update({ targetKind: "agent", targetId: "nope" }))),
      ),
    ).toBe("teams_target_not_found")
    await dispose(t)
  })

  test("a new kind of target drops the old id", async () => {
    const t = await ready()
    expect((await t.update({ targetKind: "channel" })).fields.targetId).toBeNull()
    await dispose(t)
  })

  test("with the switch on, the target, title, kind and marker are locked; the lists and call text are not", async () => {
    const t = await ready()
    expect((await t.turnOn()).enabled).toBe(true)
    for (const patch of [
      { chatTitle: "Other" },
      { chatKind: "group" as const },
      { marker: "[X]" },
      { targetId: null },
    ])
      expect(failCode(await t.exit(TeamsLink.use((l) => l.update(patch))))).toBe("teams_locked")
    const v = await t.update({
      allow: ["Marta Kim", "Joe Lee"],
      bots: ["Helper Bot"],
      callText: "@R",
    })
    expect(v.fields.allow).toEqual(["Marta Kim", "Joe Lee"])
    expect(v.fields.bots).toEqual(["Helper Bot"])
    expect(v.fields.callText).toBe("@R")
    await dispose(t)
  })
})

describe("sign-in", () => {
  test("'Sign in to Teams' makes the sign-in profile, loads Teams, and sees the form", async () => {
    const t = await setup()
    await t.setupLink()
    const v = await t.showPage()
    expect(v.pageShown).toBe(true)
    expect(v.signedIn).toBe(false)
    expect(t.chat.visits).toBe(1)
    const profiles = await t.run(BrowserProfiles.use((b) => b.list))
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ teamsLink: true, agentIds: [] })
    expect(t.teamsProfile.id).toBe(profiles[0]?.id)
    expect(v.signInProfileId).toBe(profiles[0]?.id as string)
    // The user types in the page by hand: the input reaches it.
    expect(t.chat.inputAllowed).toBe(true)
    await dispose(t)
  })

  test("the app sees the user sign in, and the switch then has a sign-in", async () => {
    const t = await setup()
    await t.setupLink()
    await t.showPage()
    expect((await t.view()).signedIn).toBe(false)
    t.chat.addChat(CHAT)
    t.chat.signInByHand(PASSWORD)
    await t.pass(3000)
    expect((await t.view()).signedIn).toBe(true)
    await dispose(t)
  })

  test("the password is in no file the app wrote and in no export", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(10_000)
    expect(t.chat.password).toBe(PASSWORD)
    t.shell.savePath = join(t.dataDir, "export.zip")
    await t.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(join(t.dataDir, "export.zip")))
    for (const data of Object.values(entries))
      expect(Buffer.from(data).includes(PASSWORD)).toBe(false)
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? walk(path) : [path]
      })
    for (const file of walk(t.dataDir)) expect(readFileSync(file).includes(PASSWORD)).toBe(false)
    // The database of the running app holds it nowhere either.
    const db = await t.run(Database.use((d) => Effect.succeed(d)))
    for (const table of db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ))
      expect(JSON.stringify(db.all(`SELECT * FROM "${table.name}"`))).not.toContain(PASSWORD)
    await dispose(t)
  })

  test("'Use this chat' fills the field with the title of the open chat", async () => {
    const t = await setup()
    await t.setupLink()
    t.chat.addChat(CHAT)
    t.chat.addChat("Team A")
    await t.showPage()
    t.chat.signInByHand(PASSWORD)
    t.chat.openByUser("Team A")
    const v = await t.run(TeamsLink.use((l) => l.useChat))
    expect(v.fields.chatTitle).toBe("Team A")
    await dispose(t)
  })

  test("'Use this chat' says why it cannot: page closed, signed out, no chat open", async () => {
    const t = await setup()
    await t.setupLink()
    t.chat.addChat(CHAT)
    expect(failCode(await t.exit(TeamsLink.use((l) => l.useChat)))).toBe("teams_page_closed")
    await t.showPage()
    expect(failCode(await t.exit(TeamsLink.use((l) => l.useChat)))).toBe("teams_signed_out")
    t.chat.signInByHand(PASSWORD)
    expect(failCode(await t.exit(TeamsLink.use((l) => l.useChat)))).toBe("teams_no_chat_open")
    t.chat.dropNetwork()
    expect(failCode(await t.exit(TeamsLink.use((l) => l.useChat)))).toBe("teams_offline")
    await dispose(t)
  })

  test("'Use this chat' does not change the title while the switch is on", async () => {
    const t = await ready()
    t.chat.openByUser(CHAT)
    await t.turnOn()
    expect(failCode(await t.exit(TeamsLink.use((l) => l.useChat)))).toBe("teams_locked")
    await dispose(t)
  })
})

describe("the states", () => {
  test("Off, Connecting, then On with the time of the last read", async () => {
    const t = await ready()
    expect((await t.view()).state).toBe("off")
    const now = t.clock.now()
    const v = await t.turnOn()
    expect(v.enabled).toBe(true)
    expect(v.state).toBe("connecting")
    await settle()
    const on = await t.view()
    expect(on.state).toBe("on")
    expect(on.lastReadAt).toBe(now)
    // It reads again every 3 seconds, and the time of the last read moves.
    await t.pass(3000)
    expect((await t.view()).lastReadAt).toBe(now + 3000)
    await dispose(t)
  })

  test("the chat opens by its title, and the link reads no message and types nothing", async () => {
    const t = await ready()
    t.chat.addChat("Team A")
    t.chat.say(CHAT, "Marta Kim", "@ROBot list my tasks")
    await t.turnOn()
    await t.pass(30_000)
    expect(t.chat.openIndex).toBe(0)
    expect(t.chat.messageReads).toBe(0)
    expect(t.chat.typed).toEqual([])
    await dispose(t)
  })

  test("the Teams page stays hidden by default while the link is on", async () => {
    const t = await ready()
    await t.hidePage()
    await t.turnOn()
    await t.pass(5000)
    expect(t.chat.isOpen).toBe(true)
    expect(t.chat.placed).toBeUndefined()
    expect((await t.view()).pageShown).toBe(false)
    await dispose(t)
  })

  test("Signed out: the form shows; after a sign-in the link goes on", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(3000)
    expect((await t.view()).state).toBe("on")
    t.chat.endSession()
    await t.pass(3000)
    const out = await t.view()
    expect(out.state).toBe("signedOut")
    expect(out.signedIn).toBe(false)
    t.chat.signInByHand(PASSWORD)
    await t.pass(3000)
    expect((await t.view()).state).toBe("on")
    expect((await t.view()).signedIn).toBe(true)
    await dispose(t)
  })

  test("Chat not found: no chat holds the title; it looks again every 30 seconds", async () => {
    const t = await ready({ chatTitle: "Project X" })
    await t.turnOn()
    await settle()
    const v = await t.view()
    expect(v.state).toBe("chatNotFound")
    expect(v.chat).toBe("none")
    const reads = t.chat.evaluations
    await t.pass(TEAMS_LOOK_AGAIN_MS - 1000)
    expect(t.chat.evaluations).toBe(reads)
    await t.pass(1000)
    expect(t.chat.evaluations).toBeGreaterThan(reads)
    // The chat appears: the link finds it at the next look.
    t.chat.addChat("Project X")
    await t.pass(TEAMS_LOOK_AGAIN_MS)
    expect((await t.view()).state).toBe("on")
    expect(t.chat.typed).toEqual([])
    await dispose(t)
  })

  test("Chat not found: more than one chat holds the title; no chat opens", async () => {
    const t = await ready({ chatTitle: "Team" })
    t.chat.addChat("Team A")
    t.chat.addChat("Team B")
    await t.turnOn()
    await settle()
    const v = await t.view()
    expect(v.state).toBe("chatNotFound")
    expect(v.chat).toBe("many")
    expect(t.chat.openIndex).toBeNull()
    expect(t.chat.typed).toEqual([])
    await dispose(t)
  })

  test("Offline: it tries every 30 seconds, never pauses, and goes on when the network returns", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(3000)
    t.chat.dropNetwork()
    await t.pass(3000)
    expect((await t.view()).state).toBe("offline")
    const visits = t.chat.visits
    await t.pass(30 * 60_000)
    const v = await t.view()
    expect(v.state).toBe("offline")
    // About one try every 30 seconds for 30 minutes.
    expect(t.chat.visits - visits).toBeGreaterThanOrEqual(55)
    expect(t.chat.visits - visits).toBeLessThanOrEqual(61)
    t.chat.restoreNetwork()
    await t.pass(TEAMS_LOOK_AGAIN_MS)
    expect((await t.view()).state).toBe("on")
    await dispose(t)
  })

  test("Connecting lasts at most 60 seconds, and then shows the state that fits", async () => {
    const t = await ready()
    // Teams changed its page: it shows neither the app nor a sign-in form.
    t.chat.breakPage()
    await t.turnOn()
    await t.pass(TEAMS_CONNECT_MAX_MS - 2000)
    expect((await t.view()).state).toBe("connecting")
    await t.pass(3000)
    expect((await t.view()).state).toBe("offline")
    await dispose(t)
  })

  test("Connecting ends at once when the page gives a clear answer", async () => {
    const t = await ready()
    t.chat.endSession()
    await t.turnOn()
    await settle()
    expect((await t.view()).state).toBe("signedOut")
    await dispose(t)
  })

  test("a script that fails is not a state: the state stays", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(3000)
    t.chat.failScripts(2)
    await t.pass(6000)
    expect((await t.view()).state).toBe("on")
    await dispose(t)
  })

  test("Target missing: an archived agent stops the link; nothing is read", async () => {
    const t = await ready()
    const a = await t.view().then((v) => v.fields.targetId as string)
    await t.turnOn()
    await t.pass(3000)
    expect((await t.view()).state).toBe("on")
    await t.run(Agents.use((x) => x.archive(a)))
    await settle()
    const v = await t.view()
    expect(v.state).toBe("targetMissing")
    expect(v.enabled).toBe(true)
    expect(t.chat.isOpen).toBe(false)
    const reads = t.chat.evaluations
    await t.pass(60_000)
    expect(t.chat.evaluations).toBe(reads)
    // The user turns the switch off, picks another target, and turns it on.
    await t.turnOff()
    const b = await t.agent("Bea")
    await t.update({ targetId: b.id })
    expect((await t.turnOn()).state).toBe("connecting")
    await t.pass(3000)
    expect((await t.view()).state).toBe("on")
    await dispose(t)
  })

  test("Target missing: a deleted channel, and the switch refuses an archived target", async () => {
    const t = await ready()
    const channel = await t.run(
      Channels.use((c) =>
        c.create({
          serverId: t.server.id,
          name: "launch",
          topic: "",
          memberIds: [],
          leadId: null,
        }),
      ),
    )
    await t.update({ targetKind: "channel", targetId: channel.id })
    await t.turnOn()
    await t.pass(3000)
    expect((await t.view()).state).toBe("on")
    await t.run(Channels.use((c) => c.remove(channel.id)))
    await settle()
    expect((await t.view()).state).toBe("targetMissing")
    await t.turnOff()
    expect((await t.turnOn()).problems).toEqual(["targetMissing"])
    await dispose(t)
  })

  test("Show and hide the Teams page: it shows in a place and hides again", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(3000)
    await t.showPage()
    await t.run(TeamsLink.use((l) => l.place({ x: 1, y: 2, width: 300, height: 200 })))
    expect(t.chat.placed).toEqual({ x: 1, y: 2, width: 300, height: 200 })
    expect(t.chat.inputAllowed).toBe(true)
    await t.hidePage()
    expect(t.chat.placed).toBeUndefined()
    expect(t.chat.inputAllowed).toBe(false)
    // The link is on, so the page stays open for it.
    expect(t.chat.isOpen).toBe(true)
    // A place sent while the page is hidden is ignored.
    await t.run(TeamsLink.use((l) => l.place({ x: 1, y: 2, width: 300, height: 200 })))
    expect(t.chat.placed).toBeUndefined()
    await dispose(t)
  })

  test("a user who looks at another chat in the shown page is not pulled back", async () => {
    const t = await ready()
    t.chat.addChat("Team A")
    await t.turnOn()
    await t.pass(3000)
    await t.showPage()
    t.chat.openByUser("Team A")
    await t.pass(9000)
    expect(t.chat.openIndex).toBe(1)
    await t.hidePage()
    await t.pass(3000)
    expect(t.chat.openIndex).toBe(0)
    await dispose(t)
  })

  test("with the switch off, 'Hide the Teams page' closes it", async () => {
    const t = await setup()
    await t.setupLink()
    await t.showPage()
    expect(t.chat.isOpen).toBe(true)
    await t.hidePage()
    expect(t.chat.isOpen).toBe(false)
    await t.pass(60_000)
    expect(t.chat.visits).toBe(1)
    await dispose(t)
  })

  test("turn off: the link stops, the page closes, and the sign-in stays", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(3000)
    const v = await t.turnOff()
    expect(v.enabled).toBe(false)
    expect(v.state).toBe("off")
    expect(t.chat.isOpen).toBe(false)
    expect(v.signedIn).toBe(true)
    const evaluations = t.chat.evaluations
    await t.pass(60_000)
    expect(t.chat.evaluations).toBe(evaluations)
    await dispose(t)
  })
})

describe("sign out and remove", () => {
  test("'Sign out of Teams' deletes the saved sign-in and turns the link off", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(3000)
    const profile = (await t.view()).signInProfileId as string
    const v = await t.run(TeamsLink.use((l) => l.signOut))
    expect(v.enabled).toBe(false)
    expect(v.signedIn).toBe(false)
    expect(v.state).toBe("off")
    expect(t.clearedProfiles).toEqual([profile])
    expect(t.chat.isOpen).toBe(false)
    // The form stays. The switch now refuses for the missing sign-in.
    expect(v.fields.chatTitle).toBe("(You)")
    expect((await t.turnOn()).problems).toEqual(["noSignIn"])
    // The stand-in shows the sign-in form again.
    await t.showPage()
    expect((await t.view()).signedIn).toBe(false)
    await dispose(t)
  })

  test("'Remove link' deletes the link and the sign-in profile", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(3000)
    const profile = (await t.view()).signInProfileId as string
    const v = await t.run(TeamsLink.use((l) => l.remove))
    expect(v.exists).toBe(false)
    expect(v.signInProfileId).toBeNull()
    expect(await t.run(BrowserProfiles.use((b) => b.list))).toEqual([])
    expect(t.clearedProfiles).toEqual([profile])
    expect(t.teamsProfile.id).toBeUndefined()
    expect(t.chat.isOpen).toBe(false)
    await dispose(t)
  })
})

describe("after a restart", () => {
  test("a link that is on starts at Connecting and reads again; the last read stays", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-teams-restart-"))
    const file = join(dir, "robot.db")
    // The stand-in Teams is the outside world: it does not restart with the app.
    const chat = new FakeChat()
    const first = testRuntime({ databaseFile: file, chat })
    const run1 = first.runtime.runPromise
    const server = await run1(Servers.use((s) => s.local))
    const agent = await run1(
      Agents.use((a) => a.create({ serverId: server.id, name: "Ada", role: "", instructions: "" })),
    )
    chat.addChat(CHAT)
    await run1(TeamsLink.use((l) => l.setup))
    await run1(TeamsLink.use((l) => l.showPage))
    chat.signInByHand(PASSWORD)
    for (let i = 0; i < 3; i++) {
      first.advance(1000)
      await settle()
    }
    await run1(
      TeamsLink.use((l) =>
        l.update({
          targetKind: "agent",
          targetId: agent.id,
          chatTitle: "(You)",
          allow: ["Marta Kim"],
        }),
      ),
    )
    await run1(TeamsLink.use((l) => l.hidePage))
    await run1(TeamsLink.use((l) => l.setEnabled(true)))
    await settle()
    const lastRead = (await run1(TeamsLink.use((l) => l.view))).lastReadAt
    expect(lastRead).not.toBeNull()
    await first.runtime.dispose()

    const visits = chat.visits
    const second = testRuntime({ databaseFile: file, chat })
    const run2 = second.runtime.runPromise
    const started = await run2(TeamsLink.use((l) => l.view))
    // The switch is still on, the state is Connecting, and the time of the last read is shown.
    expect(started.enabled).toBe(true)
    expect(started.state).toBe("connecting")
    expect(started.lastReadAt).toBe(lastRead)
    expect(started.signedIn).toBe(true)
    await settle()
    const on = await run2(TeamsLink.use((l) => l.view))
    expect(on.state).toBe("on")
    expect(chat.visits).toBeGreaterThanOrEqual(visits)
    await second.runtime.dispose()
  })

  test("a link that is off stays off, and the stand-in sees no visit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-teams-restart-"))
    const file = join(dir, "robot.db")
    const chat = new FakeChat()
    const first = testRuntime({ databaseFile: file, chat })
    await first.runtime.runPromise(TeamsLink.use((l) => l.setup))
    await first.runtime.dispose()
    const second = testRuntime({ databaseFile: file, chat })
    const v = await second.runtime.runPromise(TeamsLink.use((l) => l.view))
    expect(v.exists).toBe(true)
    expect(v.state).toBe("off")
    for (let i = 0; i < 60; i++) {
      second.advance(1000)
      await settle()
    }
    expect(chat.visits).toBe(0)
    await second.runtime.dispose()
  })

  test("a link whose target went while the app was closed starts at Target missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-teams-restart-"))
    const file = join(dir, "robot.db")
    const chat = new FakeChat()
    chat.signedIn = true
    chat.addChat(CHAT)
    const first = testRuntime({ databaseFile: file, chat })
    const run1 = first.runtime.runPromise
    const server = await run1(Servers.use((s) => s.local))
    const agent = await run1(
      Agents.use((a) => a.create({ serverId: server.id, name: "Ada", role: "", instructions: "" })),
    )
    await run1(TeamsLink.use((l) => l.setup))
    await run1(TeamsLink.use((l) => l.showPage))
    await settle()
    await run1(
      TeamsLink.use((l) =>
        l.update({
          targetKind: "agent",
          targetId: agent.id,
          chatTitle: "(You)",
          allow: ["Marta Kim"],
        }),
      ),
    )
    await run1(TeamsLink.use((l) => l.hidePage))
    await run1(TeamsLink.use((l) => l.setEnabled(true)))
    await run1(Agents.use((a) => a.archive(agent.id)))
    await first.runtime.dispose()
    const second = testRuntime({ databaseFile: file, chat })
    await settle()
    const v = await second.runtime.runPromise(TeamsLink.use((l) => l.view))
    expect(v.state).toBe("targetMissing")
    await second.runtime.dispose()
  })
})

describe("what stays on this computer (spec 028, 014, 019)", () => {
  test("an export holds no link and no sign-in profile, and an import brings none back", async () => {
    const t = await ready({ bots: ["Helper Bot"] })
    await t.turnOn()
    await t.pass(3000)
    const out = join(t.dataDir, "export.zip")
    t.shell.savePath = out
    await t.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(out))
    const archived = join(t.dataDir, "archived.db")
    writeFileSync(archived, entries["robot.db"] as Uint8Array)
    const inArchive = new DatabaseSync(archived)
    expect(inArchive.prepare("SELECT 1 FROM teams_link").all()).toEqual([])
    expect(inArchive.prepare("SELECT 1 FROM browser_profile").all()).toEqual([])
    inArchive.close()
    for (const data of Object.values(entries)) {
      const text = Buffer.from(data)
      expect(text.includes("Helper Bot")).toBe(false)
      expect(text.includes(PASSWORD)).toBe(false)
    }

    const { platform } = testPlatform()
    const second = ManagedRuntime.make(
      appLayer({
        platform: { ...platform, pickArchive: async () => out },
        databaseFile: ":memory:",
        localServerName: "Test computer",
        emit: () => {},
        secrets: Secrets.memory,
      }),
    )
    const imported = await second.runPromise(Data.use((d) => d.import()))
    expect(imported?.agents).toBe(1)
    const v = await second.runPromise(TeamsLink.use((l) => l.view))
    expect(v.exists).toBe(false)
    expect(v.signInProfileId).toBeNull()
    expect(await second.runPromise(BrowserProfiles.use((b) => b.list))).toEqual([])
    await second.dispose()
    await dispose(t)
  })

  test("sync carries neither the link nor the sign-in profile", async () => {
    const t = await ready()
    await t.turnOn()
    const db = await t.run(Database.use((d) => Effect.succeed(d)))
    expect(SYNC_KINDS.some((kind) => /teams|browser/i.test(kind))).toBe(false)
    const triggers = db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('teams_link', 'browser_profile')",
    )
    expect(triggers).toEqual([])
    await dispose(t)
  })

  test("another app data has no link, and the sign-in of the first is not used in it", async () => {
    const t = await ready()
    await t.turnOn()
    const other = testRuntime()
    const v = await other.runtime.runPromise(TeamsLink.use((l) => l.view))
    expect(v.exists).toBe(false)
    expect(v.signedIn).toBe(false)
    expect(v.signInProfileId).toBeNull()
    expect(other.teamsProfile.id).toBeUndefined()
    expect(other.chat.visits).toBe(0)
    await other.runtime.dispose()
    await dispose(t)
  })

  test("its events go to the windows of this computer only", async () => {
    const t = await ready()
    await t.turnOn()
    await t.pass(3000)
    const changes = t.events.filter((e) => e.event === "teams.changed")
    expect(changes.length).toBeGreaterThan(0)
    // The events of the link go to the windows of this computer only.
    const { PUSHED_EVENTS } = await import("@robot/link/wire")
    expect((PUSHED_EVENTS as readonly string[]).includes("teams.changed")).toBe(false)
    await dispose(t)
  })
})
