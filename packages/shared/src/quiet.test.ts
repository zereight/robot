import { describe, expect, test } from "bun:test"
import { CLIENT_METHODS, PUSHED_EVENTS } from "@robot/link/wire"
import { catalogues } from "./i18n/index.ts"
import {
  formatQuiet,
  QUIET_MS,
  type QuietTurn,
  quietOfChat,
  quietOfTask,
  quietSeconds,
  quietShown,
  quietTimeMs,
} from "./quiet.ts"

const turn = (over: Partial<QuietTurn> = {}): QuietTurn => ({
  taskId: "t1",
  agentId: "a1",
  threadId: null,
  source: "chat",
  sourceId: "a1",
  name: "Mock account",
  seconds: 90,
  ...over,
})

describe("the quiet time (spec 005)", () => {
  test("is 90 seconds, or half of the silent limit when that is shorter", () => {
    expect(QUIET_MS).toBe(90_000)
    expect(quietTimeMs(60)).toBe(90_000)
    expect(quietTimeMs(30)).toBe(90_000)
    expect(quietTimeMs(10)).toBe(90_000)
    expect(quietTimeMs(5)).toBe(90_000)
    expect(quietTimeMs(3)).toBe(90_000)
    expect(quietTimeMs(2)).toBe(60_000)
    expect(quietTimeMs(1)).toBe(30_000)
  })

  test("with the silent limit Never it is 90 seconds", () => {
    expect(quietTimeMs(0)).toBe(90_000)
  })
})

describe("the time of the quiet line", () => {
  test("reads m:ss, and h:mm:ss after one hour", () => {
    expect(formatQuiet(90)).toBe("1:30")
    expect(formatQuiet(30)).toBe("0:30")
    expect(formatQuiet(125)).toBe("2:05")
    expect(formatQuiet(3599)).toBe("59:59")
    expect(formatQuiet(3600)).toBe("1:00:00")
    expect(formatQuiet(3600 * 5 + 61)).toBe("5:01:01")
  })

  test("counts on from the seconds that the server sent, once each second", () => {
    const t = turn({ seconds: 90 })
    expect(quietSeconds(t, 10_000, 10_000)).toBe(90)
    expect(quietSeconds(t, 10_000, 10_999)).toBe(90)
    expect(quietSeconds(t, 10_000, 11_000)).toBe(91)
    expect(quietSeconds(t, 10_000, 70_000)).toBe(150)
    // A clock that went back never makes the time shorter than the value that was sent.
    expect(quietSeconds(t, 10_000, 5_000)).toBe(90)
  })

  test("is the name and the text of the time", () => {
    expect(quietShown(turn(), 0, 4_000)).toEqual({ name: "Mock account", time: "1:34" })
  })
})

describe("which turn a place shows", () => {
  test("the working line of a chat: the turn of that agent in that thread, never a channel part", () => {
    const turns = [
      turn({ taskId: "c", source: "channel", sourceId: "ch1" }),
      turn({ taskId: "x", agentId: "a2" }),
      turn({ taskId: "th", threadId: "th1" }),
      turn({ taskId: "main" }),
    ]
    expect(quietOfChat(turns, "a1", null)?.taskId).toBe("main")
    expect(quietOfChat(turns, "a1", "th1")?.taskId).toBe("th")
    expect(quietOfChat(turns, "a2", null)?.taskId).toBe("x")
    expect(quietOfChat(turns, "a3", null)).toBeUndefined()
    expect(quietOfChat([turn({ source: "channel" })], "a1", null)).toBeUndefined()
  })

  test("a routine turn and a workflow turn show in the chat of the agent", () => {
    expect(quietOfChat([turn({ source: "routine" })], "a1", null)).toBeDefined()
    expect(quietOfChat([turn({ source: "workflow" })], "a1", null)).toBeDefined()
  })

  test("a plan step, a task row and a workflow step find their turn by the task", () => {
    const turns = [turn({ taskId: "a" }), turn({ taskId: "b", source: "channel" })]
    expect(quietOfTask(turns, "b")?.source).toBe("channel")
    expect(quietOfTask(turns, "zzz")).toBeUndefined()
  })
})

describe("words and the link", () => {
  test("the line is in English and Korean, with the name and the time", () => {
    expect(catalogues.en["quiet.line"]).toBe("No answer from {name} for {time}")
    expect(catalogues.ko["quiet.line"]).toContain("{name}")
    expect(catalogues.ko["quiet.line"]).toContain("{time}")
  })

  test("a linked device asks for the quiet turns and is told the start and the end", () => {
    expect(CLIENT_METHODS).toContain("quiet.list")
    expect(PUSHED_EVENTS).toContain("quiet.changed")
  })
})
