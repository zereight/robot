import { describe, expect, test } from "bun:test"
import {
  ASKING_CUT,
  askingBlock,
  asksMember,
  assignmentFits,
  contextShare,
  cutToTokens,
  estimateTokens,
  fitSummary,
  lineTokens,
  memberTurns,
  NEWEST_UNKNOWN,
  newestWindow,
  REMINDER_CUT,
  splitAssignment,
  summaryWords,
  type WindowLine,
  withAssignment,
} from "./channelTurns.ts"

const line = (n: number, size = 40): WindowLine => ({
  role: "user",
  content: `m${n} ${"x".repeat(size)}`,
})

describe("estimateTokens", () => {
  test("a Latin character is a quarter of a token, Korean one token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100)
    expect(estimateTokens("한".repeat(10))).toBe(10)
    expect(estimateTokens("é".repeat(10))).toBe(5)
    expect(estimateTokens("")).toBe(0)
  })

  test("cutToTokens keeps the first characters that fit", () => {
    expect(cutToTokens("a".repeat(400), 10)).toBe("a".repeat(40))
    expect(cutToTokens("한글한글", 2)).toBe("한글")
    expect(cutToTokens("short", 100)).toBe("short")
    expect(cutToTokens("anything", 0)).toBe("")
  })
})

describe("newestWindow", () => {
  const lines = Array.from({ length: 30 }, (_, i) => line(30 - i)) // newest first

  test("a context of unknown size gives the newest 20", () => {
    const { newest, older } = newestWindow(lines, null)
    expect(newest).toHaveLength(NEWEST_UNKNOWN)
    expect(older).toHaveLength(10)
    // Oldest first: the newest message is the last.
    expect(newest.at(-1)?.content.startsWith("m30 ")).toBe(true)
    expect(newest[0]?.content.startsWith("m11 ")).toBe(true)
  })

  test("the newest messages fill at most a quarter of the context", () => {
    const size = 8000
    const many = Array.from({ length: 200 }, (_, i) => line(200 - i, 100))
    const { newest, older } = newestWindow(many, size)
    const used = newest.reduce((sum, l) => sum + lineTokens(l), 0)
    expect(used).toBeLessThanOrEqual(contextShare(size) as number)
    expect(newest.length).toBeGreaterThan(10)
    expect(newest.length + older.length).toBe(200)
    // It keeps the newest ones, not the first.
    expect(newest.at(-1)?.content.startsWith("m200 ")).toBe(true)
    // One more message would not have fitted.
    const next = older[0] as WindowLine
    expect(used + lineTokens(next)).toBeGreaterThan(contextShare(size) as number)
  })

  test("a newest message larger than the share is cut to the share", () => {
    const huge: WindowLine = { role: "user", content: "x".repeat(40_000) }
    const { newest, older } = newestWindow([huge, line(1)], 1000)
    expect(newest).toHaveLength(1)
    expect(lineTokens(newest[0] as WindowLine)).toBeLessThanOrEqual(250)
    expect(older).toHaveLength(1)
  })

  test("a short channel is read in full", () => {
    const { newest, older } = newestWindow([line(3), line(2), line(1)], 100_000)
    expect(newest.map((l) => l.content.slice(0, 2))).toEqual(["m1", "m2", "m3"])
    expect(older).toHaveLength(0)
  })
})

describe("asking messages", () => {
  const names = ["Ada", "Bo", "Cy"]

  test("a mention of the member or @all asks it", () => {
    expect(asksMember("@Bo please look", "Bo", names)).toBe(true)
    expect(asksMember("please look @all", "Bo", names)).toBe(true)
    expect(asksMember("@Ada please look", "Bo", names)).toBe(false)
    expect(asksMember("mail bo@x.com", "Bo", names)).toBe(false)
  })

  test("the block cuts each message to 2000 characters and lists them oldest first", () => {
    const block = askingBlock([
      { speaker: "User", text: "a".repeat(5000) },
      { speaker: "Ada", text: "short" },
    ])
    expect(block).not.toBeNull()
    const rows = (block as string).split("\n")
    expect(rows[1]).toBe(`[User]: ${"a".repeat(ASKING_CUT)}`)
    expect(rows[2]).toBe("[Ada]: short")
    expect(askingBlock([])).toBeNull()
  })
})

describe("memberTurns", () => {
  const user = (text: string): WindowLine => ({ role: "user", content: text })
  const own = (text: string): WindowLine => ({ role: "assistant", content: text })
  const many = (n: number) => Array.from({ length: n }, (_, i) => user(`message ${i + 1}`))

  test("the order is asking, summary, newest, reminder", () => {
    const turns = memberTurns("Do the thing", {
      asking: [{ speaker: "User", text: "@Bo do it" }],
      summary: "Older: A happened.",
      newest: many(12),
    })
    expect(turns[0]?.content.startsWith("Messages that asked you")).toBe(true)
    expect(turns[1]?.content).toBe(
      "Summary of the older messages of this channel:\nOlder: A happened.",
    )
    expect(turns[2]?.content).toBe("message 1")
    expect(turns.at(-2)?.content).toBe("message 12")
    expect(turns.at(-1)?.content).toBe("Reminder of your assignment:\nDo the thing")
    expect(turns).toHaveLength(2 + 12 + 1)
  })

  test("the reminder comes with 11 newest messages and not with 10", () => {
    expect(
      memberTurns("Job", { asking: [], summary: null, newest: many(11) }).at(-1)?.content,
    ).toBe("Reminder of your assignment:\nJob")
    const ten = memberTurns("Job", { asking: [], summary: null, newest: many(10) })
    expect(ten).toHaveLength(10)
    expect(ten.at(-1)?.content).toBe("message 10")
  })

  test("the reminder holds the first 600 characters of the assignment", () => {
    const turns = memberTurns("z".repeat(900), { asking: [], summary: null, newest: many(11) })
    expect(turns.at(-1)?.content).toBe(`Reminder of your assignment:\n${"z".repeat(REMINDER_CUT)}`)
  })

  test("a request that would end with a reply of the member gets the reminder", () => {
    const turns = memberTurns("Job", {
      asking: [],
      summary: null,
      newest: [user("hi"), own("hello")],
    })
    expect(turns.at(-1)?.role).toBe("user")
    expect(turns.at(-1)?.content).toBe("Reminder of your assignment:\nJob")
  })

  test("a request that would start with a reply of the member starts with a line of the user", () => {
    const turns = memberTurns("Job", {
      asking: [],
      summary: null,
      newest: [own("hello"), user("hi")],
    })
    expect(turns[0]?.role).toBe("user")
    expect(turns[1]?.content).toBe("hello")
  })

  test("with no assignment there is no reminder", () => {
    const turns = memberTurns("  ", { asking: [], summary: null, newest: many(12) })
    expect(turns).toHaveLength(12)
  })
})

describe("the head of the text", () => {
  test("the assignment comes before the instructions", () => {
    const text = withAssignment("Write the list", "Be brief.")
    expect(text.indexOf("Write the list")).toBeGreaterThanOrEqual(0)
    expect(text.indexOf("Write the list")).toBeLessThan(text.indexOf("Be brief."))
  })

  test("an empty assignment leaves the instructions as they are", () => {
    expect(withAssignment("", "Be brief.")).toBe("Be brief.")
    expect(splitAssignment("Be brief.")).toBeNull()
  })

  test("the split gives back the assignment, also when it holds blank lines", () => {
    const text = withAssignment("Your part: Intro\n\nWrite the intro", "Be brief.\n\nBe kind.")
    expect(splitAssignment(text)).toEqual({
      assignment: "Your part: Intro\n\nWrite the intro",
      instructions: "Be brief.\n\nBe kind.",
    })
  })

  test("the assignment and the instructions must fit in the context", () => {
    expect(assignmentFits("a".repeat(400), "b".repeat(400), 200)).toBe(true)
    expect(assignmentFits("a".repeat(400), "b".repeat(400), 199)).toBe(false)
    expect(assignmentFits("a".repeat(4_000_000), "b", null)).toBe(true)
  })
})

describe("the summary", () => {
  test("a small context gets a short summary and a large one at most 300 words", () => {
    expect(summaryWords(8000)).toBe(300)
    expect(summaryWords(400)).toBe(50)
    expect(summaryWords(1_000_000)).toBe(300)
  })

  test("the summary is cut to its share, with the block around it", () => {
    const size = 8000
    const cut = fitSummary("w".repeat(100_000), size) as string
    expect(estimateTokens(cut)).toBeLessThan(contextShare(size) as number)
    const block = memberTurns("Job", { asking: [], summary: cut, newest: [] })[0] as WindowLine
    expect(lineTokens(block)).toBeLessThanOrEqual(contextShare(size) as number)
    expect(fitSummary("   ", size)).toBeNull()
  })
})
