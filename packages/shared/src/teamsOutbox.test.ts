import { describe, expect, test } from "bun:test"
import { catalogues } from "./i18n/index.ts"
import { redactSecrets } from "./redact.ts"
import {
  cutLineText,
  failureReason,
  holdsLaterBack,
  isTeamsRecordReason,
  lineText,
  lineWord,
  type OutboxTiming,
  pickNext,
  recentSends,
  recordReasonWord,
  retryDelayMs,
  sendMayGo,
  sendTooOld,
  splitAnswer,
  TEAMS_DROP_AFTER_MS,
  TEAMS_HOLD_TRIES,
  TEAMS_MESSAGE_MAX,
  TEAMS_REASON_MAX,
  TEAMS_RECORD_REASONS,
  TEAMS_SEND_RATE_MAX,
  type TeamsLine,
  teamsRecordReasonKey,
  tooManyLineMayGo,
  withMarker,
} from "./teamsOutbox.ts"

const CUT = "The rest is in ROBot."
const MARKER = "[ROBot]"
const len = (text: string) => [...text].length

describe("the marker", () => {
  test("every answer starts with the marker and one space", () => {
    expect(withMarker("[ROBot]", "Done.")).toBe("[ROBot] Done.")
    // The marker is kept trimmed: no double space, no space at the start.
    expect(withMarker("  [ROBot]  ", "Done.")).toBe("[ROBot] Done.")
  })
})

describe("the split into messages", () => {
  test("a short text is one message with the marker", () => {
    expect(splitAnswer(MARKER, "Hello there", CUT)).toEqual({
      messages: ["[ROBot] Hello there"],
      cut: false,
    })
  })

  test("a text of exactly the room is one message of 4,000 characters, the marker counted", () => {
    const room = TEAMS_MESSAGE_MAX - len(`${MARKER} `)
    const { messages, cut } = splitAnswer(MARKER, "a".repeat(room), CUT)
    expect(cut).toBe(false)
    expect(messages).toHaveLength(1)
    expect(len(messages[0] as string)).toBe(TEAMS_MESSAGE_MAX)
    // One more character needs a second message.
    expect(splitAnswer(MARKER, "a".repeat(room + 1), CUT).messages).toHaveLength(2)
  })

  test("9,000 characters make 3 messages, each with the marker and at most 4,000 characters", () => {
    // Words of 9 characters and a space: the split can break at a space.
    const text = "abcdefghi ".repeat(900).trim()
    const { messages, cut } = splitAnswer(MARKER, text, CUT)
    expect(cut).toBe(false)
    expect(messages).toHaveLength(3)
    for (const m of messages) {
      expect(m.startsWith("[ROBot] ")).toBe(true)
      expect(len(m)).toBeLessThanOrEqual(TEAMS_MESSAGE_MAX)
    }
    // The pieces make the text again, in order. The breaks at a space are not lost.
    const joined = messages.map((m) => m.slice("[ROBot] ".length)).join(" ")
    expect(joined).toBe(text)
  })

  test("9,000 characters with no space or break are cut at the room, 3 messages", () => {
    const { messages } = splitAnswer(MARKER, "x".repeat(9000), CUT)
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => len(m))).toEqual([4000, 4000, 8 + 9000 - 2 * 3992])
    expect(messages.map((m) => m.slice(8)).join("")).toBe("x".repeat(9000))
  })

  test("the split breaks at a line break when there is one near the end of the room", () => {
    const first = "l".repeat(3900)
    const text = `${first}\n${"m".repeat(500)}`
    const { messages } = splitAnswer(MARKER, text, CUT)
    expect(messages).toEqual([`[ROBot] ${first}`, `[ROBot] ${"m".repeat(500)}`])
  })

  test("a space is better than a hard cut", () => {
    const text = `${"w".repeat(3000)} ${"v".repeat(3000)}`
    const { messages } = splitAnswer(MARKER, text, CUT)
    expect(messages).toEqual([`[ROBot] ${"w".repeat(3000)}`, `[ROBot] ${"v".repeat(3000)}`])
  })

  test("30,000 characters make 5 messages, and the last ends with the line that says the rest is elsewhere", () => {
    const { messages, cut } = splitAnswer(MARKER, "y".repeat(30_000), CUT)
    expect(cut).toBe(true)
    expect(messages).toHaveLength(5)
    for (const m of messages) {
      expect(m.startsWith("[ROBot] ")).toBe(true)
      expect(len(m)).toBeLessThanOrEqual(TEAMS_MESSAGE_MAX)
    }
    expect((messages[4] as string).endsWith(`\n${CUT}`)).toBe(true)
    // Only the last message has the line.
    expect(messages.slice(0, 4).some((m) => m.includes(CUT))).toBe(false)
  })

  test("a text that fills exactly 5 messages is not cut", () => {
    const room = TEAMS_MESSAGE_MAX - 8
    const { messages, cut } = splitAnswer(MARKER, "z".repeat(room * 5), CUT)
    expect(cut).toBe(false)
    expect(messages).toHaveLength(5)
    expect(messages.some((m) => m.includes(CUT))).toBe(false)
  })

  test("a long marker leaves less room, and the limit still holds", () => {
    const marker = "M".repeat(20)
    const { messages } = splitAnswer(marker, "q".repeat(20_000), CUT)
    for (const m of messages) {
      expect(m.startsWith(`${marker} `)).toBe(true)
      expect(len(m)).toBeLessThanOrEqual(TEAMS_MESSAGE_MAX)
    }
  })

  test("a character that takes two units is never cut in the middle", () => {
    const { messages } = splitAnswer(MARKER, "😀".repeat(9000), CUT)
    expect(messages.map((m) => m.slice(8)).join("")).toBe("😀".repeat(9000))
    for (const m of messages) expect(len(m)).toBeLessThanOrEqual(TEAMS_MESSAGE_MAX)
  })

  test("the spaces at both ends go, and an empty text makes no message", () => {
    expect(splitAnswer(MARKER, "  hi  \n", CUT).messages).toEqual(["[ROBot] hi"])
    expect(splitAnswer(MARKER, "   ", CUT).messages).toEqual([])
  })
})

describe("the rate of 20 in one minute", () => {
  const times = (n: number, at: number) => Array.from({ length: n }, () => at)

  test("20 messages go out in a minute and the 21st waits", () => {
    expect(sendMayGo(times(TEAMS_SEND_RATE_MAX - 1, 0), 1000)).toBe(true)
    expect(sendMayGo(times(TEAMS_SEND_RATE_MAX, 0), 1000)).toBe(false)
  })

  test("a message of 60 seconds ago does not count", () => {
    expect(sendMayGo(times(TEAMS_SEND_RATE_MAX, 0), 59_999)).toBe(false)
    expect(sendMayGo(times(TEAMS_SEND_RATE_MAX, 0), 60_000)).toBe(true)
    expect(recentSends([0, 30_000, 70_000], 90_000)).toEqual([70_000])
  })
})

describe("the back-off", () => {
  test("5 seconds after the first failed try, then twice as long, up to 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(retryDelayMs)).toEqual([
      5000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
    ])
  })
})

describe("the order of the outbox", () => {
  const at = (tries: number, nextTryAt: number): OutboxTiming => ({ tries, nextTryAt })

  test("the first message that is ready goes first", () => {
    expect(pickNext([at(0, 0), at(0, 0)], 10)).toBe(0)
    expect(pickNext([], 10)).toBeNull()
  })

  test("a message that waits for its next try holds the later messages back", () => {
    expect(pickNext([at(1, 5000), at(0, 0)], 1000)).toBeNull()
    expect(pickNext([at(2, 15_000), at(0, 0)], 1000)).toBeNull()
    expect(holdsLaterBack({ tries: 2 })).toBe(true)
  })

  test("after 3 failed tries in a row the later messages go on", () => {
    expect(TEAMS_HOLD_TRIES).toBe(3)
    expect(holdsLaterBack({ tries: 3 })).toBe(false)
    expect(pickNext([at(3, 25_000), at(0, 0)], 1000)).toBe(1)
    // The message that failed goes on to be tried at its own time, and it goes first then.
    expect(pickNext([at(3, 25_000), at(0, 0)], 26_000)).toBe(0)
  })

  test("a message that is ready goes before one that waits behind it only when it comes first", () => {
    expect(pickNext([at(0, 0), at(1, 9000)], 1000)).toBe(0)
  })
})

describe("the drop rules", () => {
  test("a message that failed is dropped one hour after its first failed try", () => {
    expect(sendTooOld(null, 10 * TEAMS_DROP_AFTER_MS)).toBe(false)
    expect(sendTooOld(1000, 1000 + TEAMS_DROP_AFTER_MS - 1)).toBe(false)
    expect(sendTooOld(1000, 1000 + TEAMS_DROP_AFTER_MS)).toBe(true)
  })

  test("the line 'Too many messages' goes out at most once each minute", () => {
    expect(tooManyLineMayGo(null, 5)).toBe(true)
    expect(tooManyLineMayGo(1000, 30_000)).toBe(false)
    expect(tooManyLineMayGo(1000, 61_000)).toBe(true)
    // A clock that went back does not block the line for good.
    expect(tooManyLineMayGo(100_000, 50_000)).toBe(true)
  })
})

describe("the lines for Teams", () => {
  const lines: [TeamsLine, string, string][] = [
    [{ kind: "noReply" }, "Done. There is no reply text.", "완료했어요. 답변 텍스트는 없어요."],
    [
      { kind: "files", count: 3 },
      "The reply has 3 files or pictures. Open them in ROBot.",
      "답변에 파일이나 그림이 3개 있어요. ROBot에서 열어 보세요.",
    ],
    [
      { kind: "files", count: 1 },
      "The reply has 1 file or picture. Open it in ROBot.",
      "답변에 파일이나 그림이 1개 있어요. ROBot에서 열어 보세요.",
    ],
    [
      { kind: "failed", name: "Ada", reason: "No answer for 5 minutes." },
      "Ada could not finish: No answer for 5 minutes.",
      "Ada이(가) 끝내지 못했어요: No answer for 5 minutes.",
    ],
    [{ kind: "stopped", name: "Ada" }, "Ada was stopped.", "Ada이(가) 중지되었어요."],
    [
      { kind: "waiting", name: "Ada" },
      "Ada waits for you in ROBot. Open the app to answer.",
      "Ada이(가) ROBot에서 기다리고 있어요. 앱을 열어 답해 주세요.",
    ],
    [
      { kind: "tooMany" },
      "Too many messages. Try again in a minute.",
      "메시지가 너무 많아요. 1분 뒤에 다시 보내 주세요.",
    ],
    [
      { kind: "queueFull", name: "Ada" },
      "Ada has 20 tasks that wait. Try again later.",
      "Ada에게 기다리는 작업이 20개 있어요. 나중에 다시 해 주세요.",
    ],
    [
      { kind: "gap" },
      "ROBot did not read this chat for a while. Messages from that time got no answer. Send them again.",
      "ROBot이 한동안 이 채팅을 읽지 못했어요. 그때 온 메시지에는 답하지 못했어요. 다시 보내 주세요.",
    ],
  ]

  test("the words of the spec, in English", () => {
    for (const [line, en] of lines) expect(lineText("en", line)).toBe(en)
    expect(cutLineText("en")).toBe(CUT)
  })

  test("the same lines in Korean, in the language of the app", () => {
    for (const [line, , ko] of lines) expect(lineText("ko", line)).toBe(ko)
    expect(cutLineText("ko")).toBe("나머지는 ROBot에서 볼 수 있어요.")
  })

  test("a line has a word for the link log, and the word holds no text", () => {
    expect(lines.map(([line]) => lineWord(line))).toEqual([
      "no_reply",
      "files",
      "files",
      "failed",
      "stopped",
      "waiting",
      "too_many",
      "queue_full",
      "gap",
    ])
  })

  test("the line of a waiting card holds no text of the step or the question", () => {
    // The line takes the name only: nothing else can reach it.
    const line = lineText("en", { kind: "waiting", name: "Ada" })
    expect(line).toBe("Ada waits for you in ROBot. Open the app to answer.")
  })
})

describe("the reason in the line 'could not finish'", () => {
  test("it is the text of the error in the language of the app", () => {
    expect(failureReason("en", { code: "silent_limit", detail: "5" })).toBe(
      "No answer for 5 minutes.",
    )
    expect(failureReason("ko", { code: "app_stopped", detail: "" })).toBe("앱이 종료되었어요.")
    // A blocked task keeps the reason of the agent as the detail.
    expect(failureReason("en", { code: "blocked", detail: "No key for the service." })).toBe(
      "No key for the service.",
    )
  })

  test("an error with no known text gives the general text, and no error does too", () => {
    expect(failureReason("en", { code: "no_such_code_xyz", detail: "x" })).toBe(
      catalogues.en["error.unknown"],
    )
    expect(failureReason("en", null)).toBe(catalogues.en["error.unknown"])
  })

  test("it is cut at 300 characters, on one line", () => {
    const long = failureReason("en", { code: "blocked", detail: `${"a b\n".repeat(200)}` })
    expect(len(long)).toBe(TEAMS_REASON_MAX)
    expect(long.includes("\n")).toBe(false)
  })
})

describe("the redaction of a reply", () => {
  test("a key of a known form is replaced before the text is split, also at a break", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"
    const text = `${"w ".repeat(1990)}${key} tail`
    const safe = redactSecrets(text)
    expect(safe).not.toContain("sk-abc")
    const { messages } = splitAnswer(MARKER, safe, CUT)
    expect(messages.join("")).not.toContain("sk-abc")
    expect(messages.join("")).toContain("[redacted]")
  })
})

describe("the records", () => {
  test("six reasons, each with a key and a word for the log", () => {
    expect(TEAMS_RECORD_REASONS).toEqual([
      "wrongChat",
      "notSent",
      "outboxFull",
      "linkOff",
      "linkPaused",
      "signedOut",
    ])
    expect(TEAMS_RECORD_REASONS.map(recordReasonWord)).toEqual([
      "wrong_chat",
      "not_sent",
      "outbox_full",
      "link_off",
      "link_paused",
      "signed_out",
    ])
    for (const reason of TEAMS_RECORD_REASONS) {
      expect(isTeamsRecordReason(reason)).toBe(true)
      expect(teamsRecordReasonKey(reason) in catalogues.en).toBe(true)
      expect(teamsRecordReasonKey(reason) in catalogues.ko).toBe(true)
    }
    expect(isTeamsRecordReason("other")).toBe(false)
  })

  test("the texts of the reasons are the words of the spec", () => {
    expect(TEAMS_RECORD_REASONS.map((r) => catalogues.en[teamsRecordReasonKey(r)])).toEqual([
      "Wrong chat",
      "Not sent",
      "Outbox full",
      "Link off",
      "Link paused",
      "Signed out",
    ])
  })
})
