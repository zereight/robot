import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { type ChatMessage, messageText } from "@robot/shared"
import { unzipSync } from "fflate"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Data } from "./Data.ts"
import { SettingsStore } from "./Settings.ts"
import { Tasks } from "./Tasks.ts"
import { TeamsLink } from "./TeamsLink.ts"
import {
  calls,
  change,
  dispose,
  MARTA,
  PROVIDER_KEY,
  ROOM,
  running,
  type S,
  settle,
  setup,
  startModel,
} from "./teamsHarness.testing.ts"

// The answers and the outbox of the Teams link (spec 028, S103) with the stand-in Teams and a
// stand-in model. Nothing here calls the real Teams. The checks follow "Acceptance" of the spec.

const model = startModel()
afterAll(() => model.stop())

const CUT = "The rest is in ROBot."
const GAP_LINE =
  "[ROBot] ROBot did not read this chat for a while. Messages from that time got no answer. Send them again."

/** The text of the last reply of the agent, as the window shows it. */
const replyText = async (s: S) => messageText((await s.reply()) as ChatMessage)

// --- The reply of a direct chat -------------------------------------------------------------------

describe("the reply of a direct chat", () => {
  test("a reply goes to the chat, starts with the marker, and is not read as a call", async () => {
    const s = await setup(model)
    await s.prepare()
    for (let i = 1; i <= 3; i++) s.chat.say(ROOM, MARTA, `@ROBot old call ${i}`)
    await s.turnOn()
    // Turn on: three old calls, no task, and nothing for Teams.
    expect(await s.tasks()).toHaveLength(0)
    expect(s.typedTexts()).toEqual([])
    s.chat.say(ROOM, MARTA, "@ROBot REPLY the sky is blue")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(2000)
    expect(s.typedTexts()).toEqual(["[ROBot] the sky is blue"])
    expect(s.chat.typed[0]?.chat).toBe(ROOM)
    // The stand-in shows it as a message of the user of the account, in the linked chat.
    const shown = (await s.chat.surface.readMessages()).messages.at(-1)
    expect(shown).toMatchObject({ text: "[ROBot] the sky is blue", own: true })
    // The app does not read its own text as a call: more reads, still one task.
    await s.pass(12_000)
    expect(await s.tasks()).toHaveLength(1)
    expect(s.reasons("call_refused")).toEqual(["own_text"])
    expect(s.reasons("answer_made")).toEqual(["reply"])
    await dispose(s)
  })

  test("the marker is the marker of the link, and it is plain text", async () => {
    const s = await setup(model)
    await s.prepare({ marker: "[Bot]" })
    await s.turnOn()
    s.chat.say(ROOM, MARTA, "@ROBot REPLY **bold** and `code` and # head")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(2000)
    // The app does not turn Markdown into Teams formatting: the text goes as it is.
    expect(s.typedTexts()).toEqual(["[Bot] **bold** and `code` and # head"])
    await dispose(s)
  })

  test("a reply of 9,000 characters goes out as 3 messages, in order, each with the marker", async () => {
    const s = await running(model)
    s.chat.say(ROOM, MARTA, "@ROBot REPLYLEN 9000")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(3000)
    const typed = s.typedTexts()
    expect(typed).toHaveLength(3)
    for (const text of typed) {
      expect(text.startsWith("[ROBot] ")).toBe(true)
      expect([...text].length).toBeLessThanOrEqual(4000)
    }
    // The pieces are the reply, in order. The whole reply is read, not the cut of the task page.
    const reply = (await replyText(s)).trim()
    expect(reply.length).toBeGreaterThan(8000)
    expect(typed.map((x) => x.slice(8)).join(" ")).toBe(reply)
    await dispose(s)
  })

  test("a reply of 30,000 characters goes out as 5 messages, and the last ends with the line of the rest", async () => {
    const s = await running(model)
    s.chat.say(ROOM, MARTA, "@ROBot REPLYLEN 30000")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(4000)
    const typed = s.typedTexts()
    expect(typed).toHaveLength(5)
    for (const text of typed) expect([...text].length).toBeLessThanOrEqual(4000)
    expect(typed[4]?.endsWith(`\n${CUT}`)).toBe(true)
    expect(typed.slice(0, 4).some((x) => x.includes(CUT))).toBe(false)
    await dispose(s)
  })

  test("a reply with a key of a known form, or a stored key, goes out with [redacted]", async () => {
    const s = await running(model)
    s.chat.say(
      ROOM,
      MARTA,
      `@ROBot REPLY keys sk-abcdefghijklmnopqrstuvwxyz0123 and ${PROVIDER_KEY} and ghp_abcdefghijklmnopqrstuvwxyz0123 end`,
    )
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(2000)
    expect(s.typedTexts()).toEqual(["[ROBot] keys [redacted] and [redacted] and [redacted] end"])
    // The key is in no text that went out and in no line of the log.
    expect(s.typedTexts().join("")).not.toContain(PROVIDER_KEY)
    expect(s.logText()).not.toContain(PROVIDER_KEY)
    await dispose(s)
  })

  test("a key at the break of two messages is replaced before the split: no part of it goes out", async () => {
    const s = await running(model)
    const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"
    s.chat.say(ROOM, MARTA, `@ROBot REPLY ${"w ".repeat(1985)}${key} tail`)
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(3000)
    const all = s.typedTexts().join("\n")
    expect(all).toContain("[redacted]")
    expect(all).not.toContain("sk-abc")
    expect(all).not.toContain("mnopqrstuvwxyz0123456789")
    await dispose(s)
  })

  test("a done task with no words sends the line for no reply text; files add one line", async () => {
    const s = await running(model)
    await s.endTask({})
    await s.endTask({ text: "   " })
    await s.endTask({ text: "Here you are.", files: 2 })
    await s.endTask({ files: 1 })
    await s.pass(5000)
    expect(s.typedTexts()).toEqual([
      "[ROBot] Done. There is no reply text.",
      "[ROBot] Done. There is no reply text.",
      "[ROBot] Here you are.",
      "[ROBot] The reply has 2 files or pictures. Open them in ROBot.",
      "[ROBot] Done. There is no reply text.",
      "[ROBot] The reply has 1 file or picture. Open it in ROBot.",
    ])
    await dispose(s)
  })

  test("only work that a message from Teams started sends text: a message of the user does not", async () => {
    const s = await running(model)
    await s.run(
      Chat.use((c) => c.send({ agentId: s.ada.id, text: "hello from the app", replyTo: null })),
    )
    await s.quiet(1)
    await s.pass(5000)
    expect(s.typedTexts()).toEqual([])
    expect(await s.records()).toEqual([])
    await dispose(s)
  })
})

// --- The lines for failed, stopped, waiting --------------------------------------------------------

describe("the lines for a task that failed, was stopped or is blocked", () => {
  test("a task that fails: the line names the agent and the reason; a retry answers in Teams", async () => {
    const s = await running(model)
    s.chat.say(ROOM, MARTA, "@ROBot FLAKY REPLY it works now")
    await s.pass(3000)
    await until(s, "failed")
    await s.pass(2000)
    expect(s.typedTexts()).toHaveLength(1)
    expect(s.typedTexts()[0]).toMatch(/^\[ROBot\] Ada could not finish: .+/)
    const [failed] = await s.taskList()
    expect(failed).toMatchObject({ source: "teams", state: "failed" })
    // The user retries the failed task: the new task has the source Teams, and its result goes out.
    await s.run(Tasks.use((t) => t.retry(failed?.id as string, { confirmed: true })))
    await s.quiet(2)
    await s.pass(3000)
    expect((await s.taskList())[1]).toMatchObject({ source: "teams", retryOf: failed?.id })
    expect(s.typedTexts().at(-1)).toBe("[ROBot] it works now")
    await dispose(s)
  })

  test("the reason is the text of the error, in one line, cut at 300 characters", async () => {
    const s = await running(model)
    await s.endTask({}, { fail: { code: "silent_limit", detail: "5" } })
    await s.endTask({}, { fail: { code: "blocked", detail: "abcdefgh \n".repeat(60) } })
    await s.endTask({}, { fail: { code: "an_unknown_code", detail: "x" } })
    await s.pass(4000)
    const [one, two, three] = s.typedTexts()
    expect(one).toBe("[ROBot] Ada could not finish: No answer for 5 minutes.")
    const reason = (two as string).slice("[ROBot] Ada could not finish: ".length)
    expect([...reason]).toHaveLength(300)
    // The reason is on one line: the line breaks of the error became spaces.
    expect(reason.includes("\n")).toBe(false)
    expect(reason.startsWith("abcdefgh abcdefgh")).toBe(true)
    expect(three).toBe("[ROBot] Ada could not finish: Something went wrong. Try again.")
    await dispose(s)
  })

  test("a blocked task sends the same line, with the reason that the agent gave", async () => {
    const s = await running(model)
    await s.endTask({}, "blocked")
    await s.pass(2000)
    expect(s.typedTexts()).toEqual(["[ROBot] Ada could not finish: The key is missing."])
    await dispose(s)
  })

  test("a failure reason that looks like a secret is replaced", async () => {
    const s = await running(model)
    await s.endTask(
      {},
      {
        fail: {
          code: "blocked",
          detail: `The key sk-abcdefghijklmnopqrstuvwxyz0123 is wrong and ${PROVIDER_KEY}`,
        },
      },
    )
    await s.pass(2000)
    expect(s.typedTexts()).toEqual([
      "[ROBot] Ada could not finish: The key [redacted] is wrong and [redacted]",
    ])
    await dispose(s)
  })

  test("the user stops a task: the line says that it was stopped", async () => {
    const s = await running(model)
    const release = model.hold()
    s.chat.say(ROOM, MARTA, "@ROBot SLOW REPLY never sent")
    await s.pass(3000)
    await until(s, "running")
    const [task] = await s.taskList()
    await s.run(Tasks.use((t) => t.stop(task?.id as string)))
    release()
    await s.quiet(1)
    await s.pass(3000)
    expect(s.typedTexts()).toEqual(["[ROBot] Ada was stopped."])
    await dispose(s)
  })

  test("a task that the restart stopped gets no answer and no record", async () => {
    const s = await running(model)
    await s.endTask({}, { fail: { code: "app_stopped" } })
    await s.pass(3000)
    expect(s.typedTexts()).toEqual([])
    expect(await s.records()).toEqual([])
    await dispose(s)
  })

  test("a task of an agent that is not the target makes no answer", async () => {
    const s = await running(model)
    await s.endTask({ text: "for Lia" }, "done", s.lia.id)
    await s.pass(3000)
    expect(s.typedTexts()).toEqual([])
    await dispose(s)
  })
})

describe("the line for a card that waits", () => {
  test("a card in a turn from Teams: one waiting line, with no text of the step; the reply goes after", async () => {
    const s = await running(model, "full")
    s.chat.say(ROOM, MARTA, `@ROBot ${calls(change("Say only yes"))}`)
    await s.pass(3000)
    await s.card("call_1")
    await s.pass(3000)
    expect(s.typedTexts()).toEqual(["[ROBot] Ada waits for you in ROBot. Open the app to answer."])
    // The card still waits a long time: no second line for the same card.
    await s.pass(30_000)
    expect(s.typedTexts()).toHaveLength(1)
    expect(s.typedTexts().join("")).not.toContain("Say only yes")
    expect(s.typedTexts().join("")).not.toContain("instructions")
    // The user allows in the app: the turn goes on and the reply goes out.
    await s.respond("call_1", "allow")
    await s.quiet(1)
    await s.pass(3000)
    expect(s.typedTexts()).toEqual([
      "[ROBot] Ada waits for you in ROBot. Open the app to answer.",
      "[ROBot] Done.",
    ])
    await dispose(s)
  })

  test("a question that waits gets the same line, with no text of the question", async () => {
    const s = await running(model)
    s.chat.say(
      ROOM,
      MARTA,
      `@ROBot ${calls({ name: "ask_user", args: { question: "Which colour do you want?", choices: ["red", "blue"] } })}`,
    )
    await s.pass(3000)
    expect(await s.card("call_1")).toMatchObject({ kind: "question" })
    await s.pass(5000)
    expect(s.typedTexts()).toEqual(["[ROBot] Ada waits for you in ROBot. Open the app to answer."])
    expect(s.typedTexts().join("")).not.toContain("colour")
    await s.respond("call_1", "red")
    await s.quiet(1)
    await s.pass(3000)
    expect(s.typedTexts().at(-1)).toBe("[ROBot] Done.")
    await dispose(s)
  })

  test("one line goes out for each card", async () => {
    const s = await running(model, "full")
    s.chat.say(ROOM, MARTA, `@ROBot ${calls(change("one"), change("two"))}`)
    await s.pass(3000)
    await s.card("call_1")
    await s.pass(3000)
    await s.respond("call_1", "allow")
    await s.card("call_2")
    await s.pass(3000)
    const waiting = s.typedTexts().filter((x) => x.includes("waits for you"))
    expect(waiting).toHaveLength(2)
    await s.respond("call_2", "allow")
    await s.quiet(1)
    await dispose(s)
  })

  test("a card of a turn that the user started sends no line, until a message from Teams waits behind it", async () => {
    const s = await running(model, "ask_all")
    await s.run(
      Chat.use((c) =>
        c.send({
          agentId: s.ada.id,
          text: calls({ name: "write_file", args: { path: "note.txt", content: "by the user" } }),
          replyTo: null,
        }),
      ),
    )
    await s.card("call_1")
    await s.pass(5000)
    // Work that the user started stays in the app.
    expect(s.typedTexts()).toEqual([])
    // A message from Teams waits behind the card: Teams gets one line.
    s.chat.say(ROOM, MARTA, "@ROBot hello there")
    await s.pass(6000)
    expect(s.typedTexts()).toEqual(["[ROBot] Ada waits for you in ROBot. Open the app to answer."])
    await s.pass(20_000)
    expect(s.typedTexts()).toHaveLength(1)
    // The user answers the card: the waiting message starts its own turn, and its reply goes out.
    await s.respond("call_1", "allow")
    await s.quiet(2)
    await s.pass(3000)
    expect(s.typedTexts().at(-1)).toBe("[ROBot] ok")
    await dispose(s)
  })

  test("no waiting line while the link is off or signed out", async () => {
    const off = await running(model, "ask_all")
    const release = model.hold()
    off.chat.say(ROOM, MARTA, `@ROBot SLOW ${calls(change("while off"))}`)
    await off.pass(3000)
    await off.turnOff()
    release()
    await off.card("call_1")
    await off.pass(10_000)
    expect(off.typedTexts()).toEqual([])
    await dispose(off)

    const out = await running(model, "ask_all")
    const again = model.hold()
    out.chat.say(ROOM, MARTA, `@ROBot SLOW ${calls(change("while signed out"))}`)
    await out.pass(3000)
    out.chat.endSession()
    await out.pass(6000)
    expect((await out.view()).state).toBe("signedOut")
    again()
    await out.card("call_1")
    await out.pass(10_000)
    expect(out.typedTexts()).toEqual([])
    await dispose(out)
  })
})

// --- The outbox -----------------------------------------------------------------------------------

describe("the outbox", () => {
  test("a failed send is tried again after 5 and 10 seconds, and holds the later answers back", async () => {
    const s = await running(model)
    s.chat.refuseSends(3)
    await s.endTask({ text: "first" })
    await s.endTask({ text: "second" })
    // The first send starts when its task ends. It ends before time moves on.
    await settle()
    await s.pass(60_000)
    const presses = s.chat.presses
    // The first answer fails 3 times in a row. The later answer waited, and went out at the third
    // failure. Then the first answer was tried again, and it went out.
    expect(presses.map((p) => [p.text.slice("[ROBot] ".length), p.refused])).toEqual([
      ["first", true],
      ["first", true],
      ["first", true],
      ["second", false],
      ["first", false],
    ])
    const at = presses.map((p) => p.at)
    expect((at[1] as number) - (at[0] as number)).toBe(5000)
    expect((at[2] as number) - (at[1] as number)).toBe(10_000)
    expect(at[3]).toBe(at[2])
    expect((at[4] as number) - (at[2] as number)).toBe(20_000)
    expect(s.typedTexts()).toEqual(["[ROBot] second", "[ROBot] first"])
    // The link records the problem once, at the third failed try, and holds no text.
    expect(s.reasons("send_failed")).toEqual(["try_1", "try_2", "try_3"])
    expect(s.reasons("send_problem")).toEqual([undefined])
    expect(await s.records()).toEqual([])
    await dispose(s)
  })

  test("a message that failed is dropped one hour after its first failed try, with the record 'Not sent'", async () => {
    const s = await running(model)
    const task = await s.endTask({ text: "never goes" })
    s.chat.refuseSends(100_000)
    await s.pass(1000)
    expect(s.chat.sendTries).toBe(1)
    await s.pass(59 * 60_000)
    expect(await s.records()).toEqual([])
    const tries = s.chat.sendTries
    expect(tries).toBeGreaterThan(5)
    // The link was not paused or stopped by the tries (that comes with a later slice).
    await s.pass(60_000 + 2000)
    const records = await s.records()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ reason: "notSent", taskId: task.id, placeName: "Ada" })
    // Nothing is tried again.
    const after = s.chat.sendTries
    await s.pass(10 * 60_000)
    expect(s.chat.sendTries).toBe(after)
    expect(s.typedTexts()).toEqual([])
    await dispose(s)
  }, 120_000)

  test("the chat changes before a send: the answer is dropped with 'Wrong chat' and never tried again", async () => {
    const s = await running(model)
    const release = model.hold()
    s.chat.say(ROOM, MARTA, "@ROBot SLOW REPLY for the right chat")
    await s.pass(3000)
    // The chat that is open changes while the agent works.
    s.chat.addChat("Other chat")
    s.chat.openByUser("Other chat")
    release()
    await s.quiet(1)
    await s.pass(1000)
    expect(s.typedTexts()).toEqual([])
    expect(s.chat.sendTries).toBe(0)
    const [task] = await s.taskList()
    const records = await s.records()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      reason: "wrongChat",
      placeKind: "agent",
      placeId: s.ada.id,
      placeName: "Ada",
      taskId: task?.id,
    })
    // The record tells when: the time of the stand-in clock.
    expect(records[0]?.at).toBeGreaterThan(0)
    expect(s.reasons("message_dropped")).toEqual(["wrong_chat"])
    // A minute later: the link opened its chat again, and nothing was ever tried again.
    await s.pass(60_000)
    expect(s.chat.typed).toEqual([])
    expect(s.chat.sendTries).toBe(0)
    expect((await s.view()).state).toBe("on")
    await dispose(s)
  })

  test("a header that shows a wrong title drops the whole answer, a record for each message", async () => {
    const s = await running(model)
    const release = model.hold()
    s.chat.say(ROOM, MARTA, "@ROBot SLOW REPLYLEN 9000")
    await s.pass(3000)
    s.chat.headerTitle = "Somebody else"
    release()
    await s.quiet(1)
    await s.pass(2000)
    expect(s.typedTexts()).toEqual([])
    expect((await s.records()).map((r) => r.reason)).toEqual([
      "wrongChat",
      "wrongChat",
      "wrongChat",
    ])
    s.chat.headerTitle = null
    await s.pass(30_000)
    expect(s.typedTexts()).toEqual([])
    await dispose(s)
  })

  test("25 answers made at once: 20 go out in the first minute and 5 in the next, in order", async () => {
    const s = await running(model)
    for (let i = 1; i <= 25; i++) await s.endTask({ text: `answer ${i}` })
    await s.pass(1000)
    const first = Array.from({ length: 20 }, (_, i) => `[ROBot] answer ${i + 1}`)
    expect(s.typedTexts()).toEqual(first)
    await s.pass(30_000)
    expect(s.typedTexts()).toEqual(first)
    await s.pass(30_000)
    expect(s.typedTexts()).toEqual(Array.from({ length: 25 }, (_, i) => `[ROBot] answer ${i + 1}`))
    expect(await s.records()).toEqual([])
    await dispose(s)
  })

  test("while the Teams page shows, the stand-in gets no text; when the page hides, the answer goes out", async () => {
    const s = await running(model)
    await s.showPage()
    const release = model.hold()
    s.chat.say(ROOM, MARTA, "@ROBot SLOW REPLY waits for the page")
    await s.pass(3000)
    release()
    await s.quiet(1)
    await s.pass(20_000)
    expect(s.typedTexts()).toEqual([])
    expect((await s.view()).pageShown).toBe(true)
    await s.hidePage()
    await s.pass(2000)
    expect(s.typedTexts()).toEqual(["[ROBot] waits for the page"])
    await dispose(s)
  })

  test("the user looks at another chat in the shown page: after hiding, the link opens its chat and the answer goes", async () => {
    const s = await running(model)
    s.chat.addChat("Another chat")
    await s.showPage()
    s.chat.openByUser("Another chat")
    await s.endTask({ text: "still goes to the right chat" })
    await s.pass(6000)
    expect(s.typedTexts()).toEqual([])
    await s.hidePage()
    await s.pass(3000)
    expect(s.chat.typed).toEqual([{ chat: ROOM, text: "[ROBot] still goes to the right chat" }])
    expect(await s.records()).toEqual([])
    await dispose(s)
  })

  test("a page that was reloaded shows no open chat: the link opens its chat, and the answer goes", async () => {
    const s = await running(model)
    await s.endTask({ text: "after the reload" })
    s.chat.reload()
    await s.pass(2000)
    expect(s.chat.typed).toEqual([{ chat: ROOM, text: "[ROBot] after the reload" }])
    await dispose(s)
  })

  test("the outbox holds 50 messages: an answer that does not fit as a whole is dropped with 'Outbox full'", async () => {
    const s = await running(model)
    await s.showPage()
    for (let i = 1; i <= 49; i++) await s.endTask({ text: `n${i}` })
    expect(await s.records()).toEqual([])
    // An answer of 3 messages does not fit in the one place that is left: none of it is kept.
    const big = await s.endTask({ text: "y".repeat(9000) })
    let records = await s.records()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ reason: "outboxFull", taskId: big.id })
    // One message fits, the next does not.
    await s.endTask({ text: "n50" })
    await s.endTask({ text: "n51" })
    records = await s.records()
    expect(records.map((r) => r.reason)).toEqual(["outboxFull", "outboxFull"])
    // When the page hides, the 50 go out in order: 20 now, then the rest in the next minutes.
    await s.hidePage()
    await s.pass(2000)
    expect(s.typedTexts()).toHaveLength(20)
    await s.pass(60_000)
    expect(s.typedTexts()).toHaveLength(40)
    await s.pass(60_000)
    expect(s.typedTexts()).toEqual([
      ...Array.from({ length: 49 }, (_, i) => `[ROBot] n${i + 1}`),
      "[ROBot] n50",
    ])
    await dispose(s)
  }, 60_000)

  test("Settings, Teams lists the newest 50 records", async () => {
    const s = await running(model)
    await s.showPage()
    for (let i = 1; i <= 50; i++) await s.endTask({ text: `fill ${i}` })
    const tasks: string[] = []
    for (let i = 1; i <= 60; i++) tasks.push((await s.endTask({ text: `over ${i}` })).id)
    const records = await s.records()
    expect(records).toHaveLength(50)
    // Newest first: the last task is the first record.
    expect(records[0]?.taskId).toBe(tasks[59])
    expect(records[49]?.taskId).toBe(tasks[10])
    expect(s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM teams_record")?.n ?? 0).toBe(50)
    await dispose(s)
  }, 60_000)
})

// --- Turn off, pause, sign out ---------------------------------------------------------------------

describe("when the link is off or signed out", () => {
  test("turning off empties the outbox, and each message gets a record with the task", async () => {
    const s = await running(model)
    await s.showPage()
    const a = await s.endTask({ text: "one" })
    const b = await s.endTask({ text: "y".repeat(9000) })
    await s.turnOff()
    expect(s.typedTexts()).toEqual([])
    const records = await s.records()
    // One record for each message: one for the first answer and three for the second.
    expect(records.map((r) => [r.reason, r.taskId])).toEqual([
      ["linkOff", b.id],
      ["linkOff", b.id],
      ["linkOff", b.id],
      ["linkOff", a.id],
    ])
    expect(s.reasons("message_dropped")).toEqual(["link_off", "link_off", "link_off", "link_off"])
    // A turn on later does not send what was dropped.
    await s.turnOn()
    await s.pass(10_000)
    expect(s.typedTexts()).toEqual([])
    await dispose(s)
  })

  test("work that ends while the switch is off gets a record and no text", async () => {
    const s = await running(model)
    const release = model.hold()
    s.chat.say(ROOM, MARTA, "@ROBot SLOW REPLY nobody reads this")
    await s.pass(3000)
    await s.turnOff()
    release()
    await s.quiet(1)
    await s.pass(5000)
    // The task ended in the app, and the stand-in got no text.
    const [task] = await s.taskList()
    expect(task?.state).toBe("done")
    expect(s.typedTexts()).toEqual([])
    expect((await s.records()).map((r) => [r.reason, r.taskId])).toEqual([
      ["linkOff", task?.id as string],
    ])
    await dispose(s)
  })

  test("Signed out empties the outbox, and work that ends then gets a record", async () => {
    const s = await running(model)
    await s.showPage()
    const a = await s.endTask({ text: "waits" })
    s.chat.endSession()
    await s.pass(6000)
    expect((await s.view()).state).toBe("signedOut")
    expect((await s.records()).map((r) => [r.reason, r.taskId])).toEqual([["signedOut", a.id]])
    const b = await s.endTask({ text: "ends while signed out" })
    expect((await s.records())[0]).toMatchObject({ reason: "signedOut", taskId: b.id })
    expect(s.reasons("message_dropped")).toEqual(["signed_out", "signed_out"])
    // After a sign-in the link reads again, and none of those answers goes out.
    s.chat.signInByHand("a password")
    await s.pass(9000)
    await s.hidePage()
    await s.pass(9000)
    expect((await s.view()).state).toBe("on")
    expect(s.typedTexts()).toEqual([])
    await dispose(s)
  })

  test("'Sign out of Teams' and 'Remove link' empty the outbox; 'Remove link' deletes the records", async () => {
    const s = await running(model)
    await s.showPage()
    await s.endTask({ text: "one" })
    await s.run(TeamsLink.use((l) => l.signOut))
    expect((await s.records()).map((r) => r.reason)).toEqual(["signedOut"])
    await s.run(TeamsLink.use((l) => l.remove))
    expect(s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM teams_record")?.n).toBe(0)
    expect((await s.view()).records).toEqual([])
    await dispose(s)
  })

  test("the outbox is in memory: a restart of the link keeps no answer (a stop empties it)", async () => {
    const s = await running(model)
    await s.showPage()
    await s.endTask({ text: "kept in memory only" })
    expect(s.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM teams_record")?.n).toBe(0)
    // No row holds the text of the answer.
    const rows = s.db.all<Record<string, unknown>>("SELECT * FROM teams_record")
    expect(JSON.stringify(rows)).not.toContain("kept in memory only")
    await dispose(s)
  })
})

// --- Lines from the read loop ---------------------------------------------------------------------

describe("the lines of the read loop", () => {
  test("'Too many messages' goes out at most once each minute", async () => {
    const s = await running(model)
    for (let i = 1; i <= 13; i++) s.chat.say(ROOM, MARTA, `@ROBot call ${i}`)
    await s.pass(3000)
    await s.quiet(10)
    await s.pass(2000)
    const lines = () => s.typedTexts().filter((x) => x.includes("Too many messages"))
    // The 11th, 12th and 13th calls start no work. Teams gets one line.
    expect(lines()).toEqual(["[ROBot] Too many messages. Try again in a minute."])
    expect(await s.tasks()).toHaveLength(10)
    // A minute later the window has room, and a new burst gets a new line.
    await s.pass(61_000)
    for (let i = 14; i <= 25; i++) s.chat.say(ROOM, MARTA, `@ROBot call ${i}`)
    await s.pass(3000)
    await s.quiet(20)
    await s.pass(2000)
    expect(lines()).toHaveLength(2)
    expect(await s.tasks()).toHaveLength(20)
    await dispose(s)
  }, 60_000)

  test("a call over a full queue gets the line with the name of the agent", async () => {
    const s = await running(model)
    for (let i = 0; i < 20; i++)
      await s.run(
        Tasks.use((t) =>
          t.create({ agentId: s.ada.id, prompt: `waits ${i}`, source: "chat", sourceId: s.ada.id }),
        ),
      )
    s.chat.say(ROOM, MARTA, "@ROBot one more")
    await s.pass(4000)
    expect(s.typedTexts()).toEqual(["[ROBot] Ada has 20 tasks that wait. Try again later."])
    await dispose(s)
  })

  test("a call that the gap skipped gets the line; a start gets none", async () => {
    const s = await running(model)
    expect(s.typedTexts()).toEqual([])
    s.chat.say(ROOM, MARTA, "@ROBot arrived in the gap")
    s.sleep(10 * 60_000)
    await s.pass(4000)
    expect(s.typedTexts()).toEqual([GAP_LINE])
    expect(await s.tasks()).toHaveLength(0)
    // A call after the jump gets an answer.
    s.chat.say(ROOM, MARTA, "@ROBot REPLY after the jump")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(2000)
    expect(s.typedTexts()).toEqual([GAP_LINE, "[ROBot] after the jump"])
    await dispose(s)
  })
})

// --- Language -------------------------------------------------------------------------------------

describe("the language of the app", () => {
  test("the lines for Teams are in Korean when the app is in Korean; the reply text is not changed", async () => {
    const s = await running(model)
    await s.run(SettingsStore.use((x) => x.update({ language: "ko" })))
    await s.endTask({})
    await s.endTask({ text: "plain reply", files: 2 })
    await s.endTask({}, { fail: { code: "silent_limit", detail: "5" } })
    s.chat.say(ROOM, MARTA, "@ROBot REPLY 안녕하세요")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(5000)
    expect(s.typedTexts()).toEqual([
      "[ROBot] 완료했어요. 답변 텍스트는 없어요.",
      "[ROBot] plain reply",
      "[ROBot] 답변에 파일이나 그림이 2개 있어요. ROBot에서 열어 보세요.",
      "[ROBot] Ada이(가) 끝내지 못했어요: 5분 동안 답이 없어요.",
      "[ROBot] 안녕하세요",
    ])
    await dispose(s)
  })
})

// --- The records and the link log -----------------------------------------------------------------

describe("the records and the link log hold no text and no name", () => {
  test("a search of the records and of the log finds no message text, no reply and no sender name", async () => {
    const s = await running(model)
    s.chat.say(ROOM, MARTA, "@ROBot REPLY purple-elephant-77 answer text")
    s.chat.say(ROOM, "Joe Lee", "@ROBot secret request of an outsider")
    s.chat.say(ROOM, "Helper Bot", "@ROBot text of a bot")
    await s.pass(3000)
    await s.quiet(1)
    await s.pass(2000)
    expect(s.typedTexts()).toEqual(["[ROBot] purple-elephant-77 answer text"])
    // A wrong chat makes a record.
    const release = model.hold()
    s.chat.say(ROOM, MARTA, "@ROBot SLOW REPLY dropped-purple-text")
    await s.pass(3000)
    s.chat.addChat("Other chat")
    s.chat.openByUser("Other chat")
    release()
    await s.quiet(2)
    await s.pass(2000)
    const records = await s.records()
    expect(records.map((r) => r.reason)).toEqual(["wrongChat"])
    // The records and the link log are searched: the table, the window's list and the file.
    const searched = [
      JSON.stringify(records),
      JSON.stringify(s.db.all("SELECT * FROM teams_record")),
      s.logText(),
    ].join("\n")
    for (const word of [
      MARTA,
      "Joe Lee",
      "Helper Bot",
      "purple-elephant-77",
      "dropped-purple-text",
      "secret request",
      "text of a bot",
      "answer text",
    ])
      expect(searched).not.toContain(word)
    await dispose(s)
  })

  test("the link log holds the time, the event, the reason and the place for what the link wrote", async () => {
    const s = await running(model)
    await s.endTask({ text: "one" })
    await s.pass(2000)
    const answered = s.log().filter((r) => r.event === "answer_made")
    expect(answered).toHaveLength(1)
    expect(Object.keys(answered[0] as object).sort()).toEqual(["event", "place", "reason", "time"])
    expect(answered[0]?.place).toBe(`agent:${s.ada.id}`)
    await dispose(s)
  })

  test("an export holds no records", async () => {
    const s = await running(model)
    await s.showPage()
    await s.endTask({ text: "one" })
    await s.turnOff()
    expect(await s.records()).toHaveLength(1)
    const path = join(s.dataDir, "export.zip")
    s.shell.savePath = path
    await s.run(Data.use((d) => d.export()))
    const entries = unzipSync(readFileSync(path))
    const archived = join(s.dataDir, "archived.db")
    writeFileSync(archived, entries["robot.db"] as Uint8Array)
    const inArchive = new DatabaseSync(archived)
    expect(inArchive.prepare("SELECT 1 FROM teams_record").all()).toEqual([])
    inArchive.close()
    await dispose(s)
  })
})

// --- A channel is not answered in this slice -------------------------------------------------------

describe("a channel target", () => {
  test("S103 writes no answer for work of a channel: the answers for a channel come with S104", async () => {
    const s = await setup(model)
    const channel = await s.run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Launch",
          topic: "Ship it",
          memberIds: [s.ada.id, s.lia.id],
          leadId: s.lia.id,
        }),
      ),
    )
    await s.prepare({ targetKind: "channel", targetId: channel.id })
    await s.turnOn()
    s.chat.say(ROOM, MARTA, "@ROBot plan the launch")
    await s.pass(5000)
    await s.pass(10_000)
    expect(s.typedTexts()).toEqual([])
    await dispose(s)
  })
})

/** Waits until a task of the stand-in has this state. */
const until = async (s: S, state: string) => {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if ((await s.tasks()).some((t) => t.state === state)) return
    await Bun.sleep(10)
  }
  throw new Error(`no task became ${state}`)
}
