import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TodayRow } from "@robot/shared"
import { FakeChat } from "../teams/fakeChat.testing.ts"
import { Agents } from "./Agents.ts"
import { Notifier } from "./Notifier.ts"
import { Servers } from "./Servers.ts"
import { SettingsStore } from "./Settings.ts"
import { TeamsLink } from "./TeamsLink.ts"
import { Today } from "./Today.ts"
import {
  dispose,
  MARTA,
  ROOM,
  running,
  type S,
  settle,
  setup,
  startModel,
  until,
} from "./teamsHarness.testing.ts"
import { testRuntime } from "./testing.ts"

// The repeated failure, the state Paused, "Resume", the notification "Teams link needs you" and
// the row in Today (spec 028, 015, 021; slice S105), with the stand-in Teams and a stand-in model.
// Nothing here calls the real Teams.

const model = startModel()
afterAll(() => model.stop())

const ALL_ON = {
  reply: true,
  mention: true,
  approval: true,
  question: true,
  task_failed: true,
  routine_failed: true,
  part_review: true,
  workflow_notice: true,
  teams_link: true,
}

const resume = (s: S) => s.run(TeamsLink.use((l) => l.resume))

/** The Today row of the Teams link, or undefined. */
const todayRow = async (s: S): Promise<TodayRow | undefined> => {
  const snapshot = await s.run(Today.use((t) => t.snapshot()))
  return snapshot.groups.flatMap((g) => g.rows).find((r) => r.id === "teams:link")
}

/** The notices of the system that carry the title of the Teams link. */
const teamsNotices = (s: S) => s.shell.notices.filter((n) => /Teams/.test(n.title))

/** Breaks the page and waits until the 20 failed reads pause the link. */
const pauseByReads = async (s: S) => {
  s.chat.breakPage()
  await s.pass(60_000)
  expect((await s.view()).state).toBe("paused")
}

/** Makes the page refuse sends and ends one task, so that 6 failed tries in a row follow. */
const pauseBySends = async (s: S) => {
  s.chat.refuseSends(1000)
  await s.endTask({ text: "never goes" })
  await s.pass(200_000)
  expect((await s.view()).state).toBe("paused")
}

// --- The repeated failure: reads --------------------------------------------------------------------

describe("20 failed reads in a row", () => {
  test("19 failed reads leave the link On; the 20th pauses it, with the reason about the page", async () => {
    const s = await running(model)
    const base = s.chat.evaluations
    s.chat.breakPage()
    // Each failed read is one look at the page: one script.
    while (s.chat.evaluations - base < 19) await s.pass(1000)
    expect((await s.view()).state).toBe("on")
    while (s.chat.evaluations - base < 20) await s.pass(1000)
    await settle()
    const view = await s.view()
    expect(view.state).toBe("paused")
    expect(view.pauseReason).toBe("read")
    expect(view.enabled).toBe(true)
    expect(s.reasons("link_paused")).toEqual(["read"])
    // The pause is kept in the database, so a restart keeps it.
    expect(s.db.get<{ paused: string }>("SELECT paused FROM teams_link")?.paused).toBe("read")
    await dispose(s)
  })

  test("a good read sets the count to 0: 19 failed, one good, 19 failed again is no pause", async () => {
    const s = await running(model)
    s.chat.breakPage()
    await s.pass(54_000)
    expect((await s.view()).state).toBe("on")
    s.chat.breakPage(false)
    await s.pass(6000)
    s.chat.breakPage()
    await s.pass(54_000)
    expect((await s.view()).state).toBe("on")
    expect(s.reasons("link_paused")).toEqual([])
    await dispose(s)
  })

  test("a page that cannot be read at the start leaves Connecting after 60 seconds, not Paused", async () => {
    const s = await setup(model)
    await s.prepare()
    // The page is open when the user turns the link on, and Teams changed it.
    await s.showPage()
    s.chat.breakPage()
    await s.run(TeamsLink.use((l) => l.setEnabled(true)))
    await s.pass(120_000)
    // Connecting ends by its own rule. A look in Offline is no failure (spec 028).
    expect((await s.view()).state).toBe("offline")
    expect(s.reasons("link_paused")).toEqual([])
    await dispose(s)
  })

  test("Offline for 30 minutes is never a pause; the first read after it is a baseline read", async () => {
    const s = await running(model)
    s.chat.dropNetwork()
    await s.pass(30 * 60_000)
    expect((await s.view()).state).toBe("offline")
    expect(s.reasons("link_paused")).toEqual([])
    s.chat.say(ROOM, MARTA, "@ROBot REPLY while the network was away")
    s.chat.restoreNetwork()
    await s.pass(40_000)
    expect((await s.view()).state).toBe("on")
    // The message of the gap got no answer: the first read after Offline marked it as read.
    expect(await s.tasks()).toHaveLength(0)
    await dispose(s)
  }, 120_000)

  test("Signed out and Chat not found are not failures, however long they last", async () => {
    const s = await running(model)
    s.chat.endSession()
    await s.pass(10 * 60_000)
    expect((await s.view()).state).toBe("signedOut")
    s.chat.signInByHand("a password")
    await s.pass(10_000)
    expect((await s.view()).state).toBe("on")
    const room = s.chat.rooms.find((r) => r.title === ROOM)
    if (room) room.title = "Another title"
    s.chat.reload()
    await s.pass(15 * 60_000)
    expect((await s.view()).state).toBe("chatNotFound")
    expect(s.reasons("link_paused")).toEqual([])
    await dispose(s)
  }, 120_000)
})

// --- The repeated failure: sends --------------------------------------------------------------------

describe("6 failed tries to send in a row", () => {
  test("5 failed tries leave the link On; the 6th pauses it, with the reason about the messages", async () => {
    const s = await running(model)
    s.chat.refuseSends(1000)
    await s.endTask({ text: "never goes" })
    // The tries come 5, 10, 20, 40 and 80 seconds apart: the sixth is at about 155 seconds.
    await s.pass(150_000)
    expect(s.chat.sendTries).toBe(5)
    expect((await s.view()).state).toBe("on")
    await s.pass(10_000)
    expect(s.chat.sendTries).toBe(6)
    const view = await s.view()
    expect(view.state).toBe("paused")
    expect(view.pauseReason).toBe("send")
    expect(s.reasons("link_paused")).toEqual(["send"])
    // The outbox is empty, and the message has the record "Link paused". Nothing is tried again.
    expect((await s.records()).map((r) => r.reason)).toEqual(["linkPaused"])
    await s.pass(10 * 60_000)
    expect(s.chat.sendTries).toBe(6)
    expect(s.typedTexts()).toEqual([])
    await dispose(s)
  })

  test("the count goes on over answers: the later answers that wait for the third failure count too", async () => {
    const s = await running(model)
    s.chat.refuseSends(1000)
    await s.endTask({ text: "first" })
    await s.endTask({ text: "second" })
    await s.pass(200_000)
    // Three tries of the first answer, then the second one goes: six failed tries in all.
    expect(s.chat.sendTries).toBe(6)
    expect((await s.view()).state).toBe("paused")
    expect((await s.records()).map((r) => r.reason)).toEqual(["linkPaused", "linkPaused"])
    await dispose(s)
  })

  test("a good send sets the count to 0: five failed tries and a good one, again, is no pause", async () => {
    const s = await running(model)
    for (const word of ["one", "two"]) {
      s.chat.refuseSends(5)
      await s.endTask({ text: word })
      await s.pass(200_000)
      expect(s.typedTexts().at(-1)).toBe(`[ROBot] ${word}`)
      expect((await s.view()).state).toBe("on")
    }
    // Ten failed tries in all, never six in a row.
    expect(s.chat.sendTries).toBe(12)
    expect(s.reasons("link_paused")).toEqual([])
    await dispose(s)
  })

  test("a chat with another title is not a failed try", async () => {
    const s = await running(model)
    s.chat.headerTitle = "Some other chat"
    for (let i = 0; i < 8; i++) await s.endTask({ text: `answer ${i}` })
    await s.pass(30_000)
    // Eight answers were dropped as "Wrong chat". Eight tries, and no pause: the page works.
    expect((await s.records()).map((r) => r.reason)).toEqual(Array(8).fill("wrongChat"))
    expect(s.reasons("link_paused")).toEqual([])
    s.chat.headerTitle = null
    await dispose(s)
  })

  test("a network that drops while an answer waits does not pause the link", async () => {
    const s = await running(model)
    s.chat.dropNetwork()
    await s.endTask({ text: "waits for the network" })
    await s.pass(30 * 60_000)
    expect((await s.view()).state).toBe("offline")
    expect(s.reasons("link_paused")).toEqual([])
    s.chat.restoreNetwork()
    await s.pass(60_000)
    expect((await s.view()).state).toBe("on")
    expect(s.typedTexts()).toEqual(["[ROBot] waits for the network"])
    await dispose(s)
  }, 120_000)
})

// --- The pause --------------------------------------------------------------------------------------

describe("what a pause does", () => {
  test("the link reads and sends nothing; work that ends gets the record 'Link paused'", async () => {
    const s = await running(model)
    await pauseByReads(s)
    // The Teams page is closed, and nothing looks at it.
    expect(s.chat.isOpen).toBe(false)
    const looks = s.chat.evaluations
    const visits = s.chat.visits
    s.chat.say(ROOM, MARTA, "@ROBot REPLY a call in the pause")
    const task = await s.endTask({ text: "a reply in the pause" })
    await s.pass(10 * 60_000)
    expect(s.chat.evaluations).toBe(looks)
    expect(s.chat.visits).toBe(visits)
    expect(await s.tasks()).toHaveLength(1)
    expect(s.typedTexts()).toEqual([])
    expect((await s.records())[0]).toMatchObject({ reason: "linkPaused", taskId: task.id })
    expect(s.reasons("message_dropped")).toEqual(["link_paused"])
    await dispose(s)
  }, 120_000)

  test("the header mark and Settings, Teams read the state: Paused with its reason", async () => {
    const s = await running(model)
    await pauseBySends(s)
    const view = await s.view()
    expect(view.state).toBe("paused")
    expect(view.pauseReason).toBe("send")
    expect(view.exists && view.enabled).toBe(true)
    await dispose(s)
  })

  test("a pause empties the outbox, and no waiting line is made while it lasts", async () => {
    const s = await running(model)
    await pauseBySends(s)
    expect(s.reasons("answer_made").length).toBe(1)
    await s.endTask({ text: "later" })
    await s.pass(10_000)
    expect(s.reasons("answer_made").length).toBe(1)
    await dispose(s)
  })

  test("the user turns the switch off: the pause ends, and the next switch on starts clean", async () => {
    const s = await running(model)
    await pauseByReads(s)
    await s.turnOff()
    const off = await s.view()
    expect(off.state).toBe("off")
    expect(off.pauseReason).toBeNull()
    expect(s.db.get<{ paused: string | null }>("SELECT paused FROM teams_link")?.paused).toBeNull()
    await s.turnOn()
    expect((await s.view()).state).toBe("on")
    await dispose(s)
  })
})

describe("Resume", () => {
  test("it starts again with a baseline read: nothing from the time of the pause gets an answer", async () => {
    const s = await running(model)
    await pauseByReads(s)
    s.chat.say(ROOM, MARTA, "@ROBot REPLY a call in the pause")
    const view = await resume(s)
    expect(view.state).toBe("connecting")
    expect(view.pauseReason).toBeNull()
    await s.pass(3000)
    expect((await s.view()).state).toBe("on")
    expect(await s.tasks()).toHaveLength(0)
    // The baseline read has the reason "resume", and Teams gets no line about it.
    expect(s.reasons("baseline").at(-1)).toBe("resume")
    expect(s.reasons("link_resumed")).toEqual([undefined])
    expect(s.typedTexts()).toEqual([])
    expect(s.db.get<{ paused: string | null }>("SELECT paused FROM teams_link")?.paused).toBeNull()
    // A call after the resume starts work and gets its answer.
    s.chat.say(ROOM, MARTA, "@ROBot REPLY back again")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(3000)
    expect(await s.tasks()).toHaveLength(1)
    expect(s.typedTexts()).toEqual(["[ROBot] back again"])
    await dispose(s)
  })

  test("a resume after a pause by sends works the same way", async () => {
    const s = await running(model)
    await pauseBySends(s)
    s.chat.refuseSends(0)
    await resume(s)
    await s.pass(3000)
    expect((await s.view()).state).toBe("on")
    await s.endTask({ text: "after the resume" })
    await s.pass(10_000)
    expect(s.typedTexts()).toEqual(["[ROBot] after the resume"])
    await dispose(s)
  })

  test("it does nothing when the link is not paused", async () => {
    const s = await running(model)
    const before = s.reasons("baseline").length
    const view = await resume(s)
    expect(view.state).toBe("on")
    expect(s.reasons("baseline")).toHaveLength(before)
    await dispose(s)
  })

  test("if the cause stays, the link pauses again after 20 failed reads and tells the user again", async () => {
    const s = await running(model)
    s.shell.focused = false
    await pauseByReads(s)
    expect(teamsNotices(s)).toHaveLength(1)
    await resume(s)
    await s.pass(3000)
    s.chat.breakPage()
    await s.pass(60_000)
    expect((await s.view()).state).toBe("paused")
    expect(teamsNotices(s)).toHaveLength(2)
    await dispose(s)
  })
})

// --- After a restart --------------------------------------------------------------------------------

describe("after a restart", () => {
  test("a paused link stays paused until the user presses Resume, and a start makes no second notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-teams-pause-"))
    const file = join(dir, "robot.db")
    const chat = new FakeChat()
    chat.signedIn = true
    chat.addChat("Team room")
    const first = testRuntime({ databaseFile: file, chat })
    first.shell.focused = false
    const run1 = first.runtime.runPromise
    const server = await run1(Servers.use((s) => s.local))
    const agent = await run1(
      Agents.use((a) => a.create({ serverId: server.id, name: "Ada", role: "", instructions: "" })),
    )
    const pass1 = async (ms: number) => {
      for (let spent = 0; spent < ms; spent += 1000) {
        first.advance(1000)
        await settle()
      }
    }
    await run1(TeamsLink.use((l) => l.setup))
    await run1(TeamsLink.use((l) => l.showPage))
    await settle()
    await run1(
      TeamsLink.use((l) =>
        l.update({
          targetKind: "agent",
          targetId: agent.id,
          chatTitle: "Team room",
          allow: [MARTA],
        }),
      ),
    )
    await run1(TeamsLink.use((l) => l.hidePage))
    await run1(TeamsLink.use((l) => l.setEnabled(true)))
    await pass1(5000)
    chat.breakPage()
    await pass1(60_000)
    const paused = await run1(TeamsLink.use((l) => l.view))
    expect(paused.state).toBe("paused")
    expect(first.shell.notices).toHaveLength(1)
    await first.runtime.dispose()

    const visits = chat.visits
    const second = testRuntime({ databaseFile: file, chat })
    second.shell.focused = false
    const run2 = second.runtime.runPromise
    const view = await run2(TeamsLink.use((l) => l.view))
    expect(view.state).toBe("paused")
    expect(view.pauseReason).toBe("read")
    expect(view.enabled).toBe(true)
    // The Today row shows again after the restart.
    const attention = await run2(TeamsLink.use((l) => l.attention))
    expect(attention).toMatchObject({ state: "paused", reason: "read" })
    for (let i = 0; i < 60; i++) {
      second.advance(1000)
      await settle()
    }
    // The link reads nothing and the page stays closed; the user knew of the pause already.
    expect(chat.visits).toBe(visits)
    expect((await run2(TeamsLink.use((l) => l.view))).state).toBe("paused")
    expect(second.shell.notices).toHaveLength(0)
    // "Resume" starts it again.
    await run2(TeamsLink.use((l) => l.resume))
    for (let i = 0; i < 5; i++) {
      second.advance(1000)
      await settle()
    }
    expect((await run2(TeamsLink.use((l) => l.view))).state).toBe("on")
    await second.runtime.dispose()
  }, 60_000)
})

// --- The notification -------------------------------------------------------------------------------

describe("the notification 'Teams link needs you'", () => {
  test("a pause makes one notification with the state and the reason, and none each cycle", async () => {
    const s = await running(model)
    s.shell.focused = false
    await pauseByReads(s)
    expect(teamsNotices(s)).toHaveLength(1)
    expect(teamsNotices(s)[0]).toMatchObject({
      title: "Teams link needs you",
      body: "Paused after repeated failure. The app cannot read the Teams page.",
    })
    // The loop goes on for a long time: no second notification.
    await s.pass(20 * 60_000)
    expect(teamsNotices(s)).toHaveLength(1)
    // A click opens Settings, Teams.
    teamsNotices(s)[0]?.click()
    expect(s.events.filter((e) => e.event === "app.openPage").map((e) => e.payload)).toEqual([
      { page: "teams" },
    ])
    await dispose(s)
  }, 120_000)

  test("a pause by sends names its own reason", async () => {
    const s = await running(model)
    s.shell.focused = false
    await pauseBySends(s)
    expect(teamsNotices(s)[0]?.body).toBe(
      "Paused after repeated failure. Teams does not take the messages.",
    )
    await dispose(s)
  })

  test("Signed out makes one notification; it goes again only after the state was fine", async () => {
    const s = await running(model)
    s.shell.focused = false
    s.chat.endSession()
    await s.pass(6000)
    expect((await s.view()).state).toBe("signedOut")
    expect(teamsNotices(s)).toHaveLength(1)
    expect(teamsNotices(s)[0]).toMatchObject({
      title: "Teams link needs you",
      body: "Signed out. Sign in to Teams to go on.",
    })
    await s.pass(10 * 60_000)
    expect(teamsNotices(s)).toHaveLength(1)
    // The user signs in: the state is fine. The next sign-out is a new change.
    await s.showPage()
    s.chat.signInByHand("a password")
    await s.pass(9000)
    await s.hidePage()
    await s.pass(9000)
    expect((await s.view()).state).toBe("on")
    s.chat.endSession()
    await s.pass(9000)
    expect((await s.view()).state).toBe("signedOut")
    expect(teamsNotices(s)).toHaveLength(2)
    await dispose(s)
  }, 120_000)

  test("a flap between Signed out and Offline makes one notification only", async () => {
    const s = await running(model)
    s.shell.focused = false
    s.chat.endSession()
    await s.pass(6000)
    for (let i = 0; i < 3; i++) {
      s.chat.dropNetwork()
      await s.pass(35_000)
      expect((await s.view()).state).toBe("offline")
      s.chat.restoreNetwork()
      await s.pass(35_000)
      expect((await s.view()).state).toBe("signedOut")
    }
    expect(teamsNotices(s)).toHaveLength(1)
    await dispose(s)
  }, 120_000)

  test("none goes out when the user turned the link off, or for Offline and Chat not found", async () => {
    const s = await running(model)
    s.shell.focused = false
    s.chat.dropNetwork()
    await s.pass(40_000)
    expect((await s.view()).state).toBe("offline")
    s.chat.restoreNetwork()
    await s.pass(40_000)
    const room = s.chat.rooms.find((r) => r.title === ROOM)
    if (room) room.title = "Another title"
    s.chat.reload()
    await s.pass(40_000)
    expect((await s.view()).state).toBe("chatNotFound")
    await s.turnOff()
    await s.pass(10_000)
    expect(teamsNotices(s)).toHaveLength(0)
    await dispose(s)
  }, 120_000)

  test("the user turns off a link that is signed out or paused: no second notification", async () => {
    const s = await running(model)
    s.shell.focused = false
    await pauseByReads(s)
    expect(teamsNotices(s)).toHaveLength(1)
    await s.turnOff()
    await s.pass(10_000)
    expect(teamsNotices(s)).toHaveLength(1)
    await dispose(s)
  })

  test("it follows the rules of 015: the kind can be turned off, a mute silences it, a focused window needs none", async () => {
    const off = await running(model)
    off.shell.focused = false
    await off.run(
      SettingsStore.use((st) => st.update({ notifyKinds: { ...ALL_ON, teams_link: false } })),
    )
    await pauseByReads(off)
    expect(teamsNotices(off)).toHaveLength(0)
    // The Today row shows anyway.
    expect(await todayRow(off)).toBeDefined()
    await dispose(off)

    const muted = await running(model)
    muted.shell.focused = false
    await muted.run(Notifier.use((n) => n.setMute("server", muted.local.id, "1h")))
    await pauseByReads(muted)
    expect(teamsNotices(muted)).toHaveLength(0)
    await dispose(muted)

    const focused = await running(model)
    focused.shell.focused = true
    await pauseByReads(focused)
    expect(teamsNotices(focused)).toHaveLength(0)
    await dispose(focused)
  }, 120_000)

  test("a linked computer or phone never gets it", async () => {
    const s = await running(model)
    s.shell.focused = false
    await pauseByReads(s)
    expect(teamsNotices(s)).toHaveLength(1)
    expect(s.events.filter((e) => e.event === "notice")).toEqual([])
    await dispose(s)
  })

  test("the texts are in Korean when the app is in Korean", async () => {
    const s = await running(model)
    s.shell.focused = false
    await s.run(SettingsStore.use((st) => st.update({ language: "ko" })))
    await pauseByReads(s)
    expect(teamsNotices(s)[0]).toMatchObject({
      title: "Teams 연동 확인이 필요해요",
      body: "반복된 실패로 멈췄어요. 앱이 Teams 페이지를 읽지 못해요.",
    })
    await dispose(s)
  })
})

// --- The row in Today -------------------------------------------------------------------------------

describe("the row in Today", () => {
  test("a pause shows one row in 'Went wrong' that opens Settings, Teams; Resume removes it", async () => {
    const s = await running(model)
    expect(await todayRow(s)).toBeUndefined()
    await pauseByReads(s)
    const row = await todayRow(s)
    expect(row).toMatchObject({
      kind: "teams_paused",
      text: "",
      reason: { code: "read", detail: "" },
      open: { kind: "teams" },
    })
    const snapshot = await s.run(Today.use((t) => t.snapshot()))
    const group = snapshot.groups.find((g) => g.rows.some((r) => r.id === "teams:link"))
    expect(group?.id).toBe("wrong")
    // The badge counts "Needs you" only: the row of the Teams link is not in it.
    expect(snapshot.badge).toBe(0)
    // The row stays while the state is the same, also much later.
    await s.pass(30 * 60_000)
    expect(await todayRow(s)).toBeDefined()
    await resume(s)
    await s.pass(3000)
    expect(await todayRow(s)).toBeUndefined()
    await dispose(s)
  }, 120_000)

  test("Signed out shows a row until the user signs in", async () => {
    const s = await running(model)
    s.chat.endSession()
    await s.pass(6000)
    expect(await todayRow(s)).toMatchObject({ kind: "teams_signed_out", open: { kind: "teams" } })
    await s.showPage()
    s.chat.signInByHand("a password")
    await s.pass(9000)
    await s.hidePage()
    await s.pass(9000)
    expect((await s.view()).state).toBe("on")
    expect(await todayRow(s)).toBeUndefined()
    await dispose(s)
  })

  test("a link that is off shows no row, also when it was paused", async () => {
    const s = await running(model)
    await pauseByReads(s)
    await s.turnOff()
    expect(await todayRow(s)).toBeUndefined()
    await dispose(s)
  })

  test("the page gets the change within a second, by its own event", async () => {
    const s = await running(model)
    const before = s.events.filter((e) => e.event === "today.changed").length
    await pauseByReads(s)
    await until(
      () =>
        s.events
          .filter((e) => e.event === "today.changed")
          .slice(before)
          .some((e) => JSON.stringify(e.payload).includes("teams_paused")),
      3000,
    )
    await dispose(s)
  })
})

// --- No text, no name -------------------------------------------------------------------------------

describe("no message text and no sender name", () => {
  test("the notification, the row, the records and the link log hold neither", async () => {
    const s = await setup(model)
    await s.prepare({ allow: [MARTA, "Zed Quill"] })
    await s.turnOn()
    s.shell.focused = false
    s.chat.say(ROOM, "Zed Quill", "@ROBot REPLY the plan-in-secret-4471")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(5000)
    expect(s.typedTexts()).toEqual(["[ROBot] the plan-in-secret-4471"])
    await s.endTask({ text: "a reply of plan-in-secret-4471" })
    await pauseBySends(s)
    const row = await todayRow(s)
    const seen = JSON.stringify([
      teamsNotices(s).map((n) => [n.title, n.body]),
      row,
      await s.records(),
      s.logText(),
    ])
    for (const word of ["Zed Quill", "plan-in-secret-4471", MARTA, ROOM])
      expect(seen).not.toContain(word)
    expect(teamsNotices(s)).toHaveLength(1)
    await dispose(s)
  })
})
