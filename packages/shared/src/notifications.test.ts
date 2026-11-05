import { describe, expect, test } from "bun:test"
import {
  askStep,
  attentionAnswers,
  attentionIndex,
  attentionText,
  firstLine,
  formatRunTime,
  ISLAND_BAR_WIDTH,
  ISLAND_WORKING_MAX,
  type IslandAttention,
  type IslandResult,
  type IslandState,
  islandBarWidth,
  islandShape,
  islandWingWidth,
  isMuted,
  isResultKind,
  mentionsUser,
  muteUntil,
  type NotifyKind,
  runningStepKind,
  toolNameOf,
  toolStepKind,
} from "./notifications.ts"

describe("mutes", () => {
  const now = 1_000_000
  test("durations", () => {
    expect(muteUntil("1h", now)).toBe(now + 3_600_000)
    expect(muteUntil("8h", now)).toBe(now + 8 * 3_600_000)
    expect(muteUntil("1d", now)).toBe(now + 86_400_000)
    expect(muteUntil("forever", now)).toBeNull()
    expect(muteUntil("off", now)).toBeUndefined()
  })
  test("a server or a channel mute applies until it ends", () => {
    const mutes = [
      { kind: "channel", id: "c1", until: now + 10 },
      { kind: "server", id: "s2", until: null },
    ] as const
    expect(isMuted(mutes, "s1", "c1", now)).toBe(true)
    expect(isMuted(mutes, "s1", "c1", now + 11)).toBe(false)
    expect(isMuted(mutes, "s1", "c2", now)).toBe(false)
    expect(isMuted(mutes, "s1", null, now)).toBe(false)
    expect(isMuted(mutes, "s2", "c9", now + 1e9)).toBe(true)
  })
})

const agent = { id: "a", name: "Ada", face: { shape: 0, hue: 0 } }
const waiting = (callId: string, agentId = "a"): IslandAttention => ({
  agentId,
  agent,
  callId,
  kind: "approval",
  summary: "rm x",
  place: null,
  step: "command",
  always: true,
  target: { kind: "agent", id: agentId },
})
const result: IslandResult = {
  id: 1,
  kind: "reply",
  agent,
  place: null,
  line: "Done",
  reason: null,
  target: { kind: "agent", id: "a" },
}

test("island shape follows the mode, attention and a result", () => {
  const base: IslandState = {
    mode: "always",
    working: [],
    count: 0,
    rows: [],
    waiting: [],
    result: null,
  }
  expect(islandShape(base)).toBe("bar")
  expect(islandShape({ ...base, mode: "attention" })).toBe("hidden")
  expect(islandShape({ ...base, mode: "attention", waiting: [waiting("c")] })).toBe("attention")
  expect(islandShape({ ...base, mode: "off", waiting: [waiting("c")] })).toBe("hidden")
  // The result card is for the mode "always". A request for attention comes before it.
  expect(islandShape({ ...base, result })).toBe("result")
  expect(islandShape({ ...base, mode: "attention", result })).toBe("hidden")
  expect(islandShape({ ...base, result, waiting: [waiting("c")] })).toBe("attention")
})

describe("kinds of step", () => {
  test("tool names of the app and of the vendor programs", () => {
    expect(toolStepKind("read_file")).toBe("files")
    expect(toolStepKind("Edit")).toBe("files")
    expect(toolStepKind("file_change")).toBe("files")
    expect(toolStepKind("run_command")).toBe("command")
    expect(toolStepKind("Bash")).toBe("command")
    expect(toolStepKind("shell")).toBe("command")
    expect(toolStepKind("exec_command")).toBe("command")
    expect(toolStepKind("fetch_url")).toBe("web")
    expect(toolStepKind("WebSearch")).toBe("web")
    expect(toolStepKind("browser_click")).toBe("browser")
    expect(toolStepKind("mcp__files__read")).toBe("connection")
    expect(toolStepKind("github.create_issue")).toBe("connection")
    expect(toolStepKind("Task")).toBe("agent")
    expect(toolStepKind("computer_click")).toBe("computer")
  })
  test("a name that is none of the kinds has no kind", () => {
    expect(toolStepKind("save_memory")).toBeNull()
    expect(toolStepKind("ask_user")).toBeNull()
    expect(toolStepKind("")).toBeNull()
    expect(toolStepKind("a/b.c")).toBeNull()
  })
  test("the step that runs is the last tool that has not ended", () => {
    const tool = (name: string, state: "running" | "waiting" | "done" | "failed") =>
      ({ kind: "tool", id: name, name, label: name, state, input: "", output: "" }) as const
    expect(runningStepKind([])).toBeNull()
    expect(runningStepKind([tool("read_file", "done"), tool("run_command", "running")])).toBe(
      "command",
    )
    expect(runningStepKind([tool("run_command", "running"), tool("read_file", "done")])).toBe(
      "command",
    )
    expect(runningStepKind([tool("run_command", "waiting")])).toBe("command")
    expect(runningStepKind([tool("run_command", "done"), { kind: "text", text: "ok" }])).toBeNull()
    expect(toolNameOf([tool("run_command", "running")], "run_command")).toBe("run_command")
    expect(toolNameOf([tool("run_command", "running")], "other")).toBeUndefined()
  })
  test("a card that waits has a kind of step, a question has none", () => {
    expect(askStep({ kind: "approval", summary: "x" }, "run_command")).toBe("command")
    expect(askStep({ kind: "approval", summary: "x" }, undefined)).toBeNull()
    expect(askStep({ kind: "question", question: "q", choices: [] }, "run_command")).toBeNull()
    expect(askStep({ kind: "article", title: "t", before: "", after: null }, undefined)).toBe(
      "files",
    )
  })
})

describe("text of the cards", () => {
  test("an approval keeps 90 characters, a question 160", () => {
    expect([...attentionText("approval", "x".repeat(200))]).toHaveLength(90)
    expect(attentionText("approval", "x".repeat(200)).endsWith("…")).toBe(true)
    expect([...attentionText("question", "q".repeat(200))]).toHaveLength(160)
    expect(attentionText("question", "short  text\n  here")).toBe("short text here")
    expect(attentionText("approval", "y".repeat(90))).toBe("y".repeat(90))
  })
  test("the line of a reply is its first line with text, at most 90 characters", () => {
    expect(firstLine("Hello there\nSecond line")).toBe("Hello there")
    expect(firstLine("\n\n  \r\nFirst\r\nSecond")).toBe("First")
    expect(firstLine("")).toBe("")
    expect([...firstLine("é".repeat(120))]).toHaveLength(90)
  })
  test("run time reads m:ss, and h:mm:ss after one hour", () => {
    expect(formatRunTime(0)).toBe("0:00")
    expect(formatRunTime(999)).toBe("0:00")
    expect(formatRunTime(61_000)).toBe("1:01")
    expect(formatRunTime(59 * 60_000 + 59_000)).toBe("59:59")
    expect(formatRunTime(3_600_000)).toBe("1:00:00")
    expect(formatRunTime(3_600_000 + 5 * 60_000 + 9_000)).toBe("1:05:09")
    expect(formatRunTime(-5)).toBe("0:00")
  })
  test("only a reply and a failure make a result card", () => {
    expect(
      ["reply", "task_failed", "routine_failed"].every((k) => isResultKind(k as NotifyKind)),
    ).toBe(true)
    for (const k of ["mention", "approval", "question", "workflow_notice"] as const)
      expect(isResultKind(k)).toBe(false)
  })
})

describe("answers of the attention card", () => {
  test("an approval of this computer offers Allow, Always allow and Deny", () => {
    expect(attentionAnswers({ kind: "approval", always: true })).toEqual([
      "allow",
      "always",
      "deny",
    ])
  })
  test("an approval with no choice to always allow, or of the sync peer, offers Allow and Deny", () => {
    expect(attentionAnswers({ kind: "approval", always: false })).toEqual(["allow", "deny"])
  })
  test("a question offers no button to answer", () => {
    expect(attentionAnswers({ kind: "question", always: false })).toEqual([])
    expect(attentionAnswers({ kind: "question", always: true })).toEqual([])
  })
})

describe("which request the attention card shows", () => {
  const list = (...ids: string[]) => ids.map((id) => waiting(id))
  test("the request that shows stays when others come or go", () => {
    expect(attentionIndex(list("a", "b", "c"), 1, list("a", "b", "c", "d"))).toBe(1)
    expect(attentionIndex(list("a", "b", "c"), 1, list("b", "c"))).toBe(0)
    expect(attentionIndex(list("a", "b", "c"), 2, list("a", "c"))).toBe(1)
  })
  test("after an answer the card shows the next request at once", () => {
    expect(attentionIndex(list("a", "b", "c"), 0, list("b", "c"))).toBe(0)
    expect(attentionIndex(list("a", "b", "c"), 1, list("a", "c"))).toBe(1)
    // The last one was answered: the card goes back to the one before.
    expect(attentionIndex(list("a", "b", "c"), 2, list("a", "b"))).toBe(1)
  })
  test("an empty list shows the first place", () => {
    expect(attentionIndex(list("a"), 0, [])).toBe(0)
    expect(attentionIndex([], 0, list("a"))).toBe(0)
  })
})

test("mentions of the user", () => {
  expect(mentionsUser("Hi @you, done")).toBe(true)
  expect(mentionsUser("@User please check")).toBe(true)
  expect(mentionsUser("mail me@you.com")).toBe(false)
  expect(mentionsUser("@Bo go")).toBe(false)
})

describe("When the island bar has a camera notch", () => {
  describe("with a notch on the screen", () => {
    test("is the notch plus a wing at each side of it", () => {
      expect(islandBarWidth(185)).toBe(185 + islandWingWidth() * 2)
    })

    test("is wider than the bar of a screen with no notch", () => {
      expect(islandBarWidth(185)).toBeGreaterThan(ISLAND_BAR_WIDTH)
    })

    test("grows wider with a wider notch", () => {
      expect(islandBarWidth(220)).toBeGreaterThan(islandBarWidth(185))
    })

    test("keeps 340 px for a notch that the two wings already fit in", () => {
      expect(islandBarWidth(120)).toBe(ISLAND_BAR_WIDTH)
    })

    test("is a whole number of px, for the window", () => {
      expect(Number.isInteger(islandBarWidth(185))).toBe(true)
      expect(Number.isInteger(islandBarWidth(184.6))).toBe(true)
    })
  })

  describe("with no notch on the screen", () => {
    test("keeps 340 px", () => {
      expect(islandBarWidth(0)).toBe(ISLAND_BAR_WIDTH)
    })

    test("treats a width below zero as no notch", () => {
      expect(islandBarWidth(-10)).toBe(ISLAND_BAR_WIDTH)
    })
  })
})

describe("When the island bar holds faces", () => {
  describe("with one agent to three agents", () => {
    test("gives the faces at least the place of the mark", () => {
      for (let shown = 1; shown <= ISLAND_WORKING_MAX; shown++)
        expect(islandWingWidth(shown)).toBeGreaterThanOrEqual(islandWingWidth(0))
    })

    test("does not grow past the three faces that the bar shows", () => {
      expect(islandWingWidth(9)).toBe(islandWingWidth(ISLAND_WORKING_MAX))
    })
  })
})
