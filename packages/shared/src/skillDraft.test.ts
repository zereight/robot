import { describe, expect, test } from "bun:test"
import {
  cutSkillText,
  draftName,
  SKILL_REQUEST_MAX,
  SKILL_REQUEST_STEPS_MAX,
  SKILL_REQUEST_TARGET_MAX,
  type SkillSource,
  skillRequest,
  skillStepLines,
  skillStepTarget,
} from "./skillDraft.ts"
import { SKILL_NAME_MAX, skillNameKey } from "./skills.ts"

const length = (text: string) => [...text].length

const task = (over: Partial<Extract<SkillSource, { kind: "task" }>> = {}): SkillSource => ({
  kind: "task",
  prompt: "Get the weekly report",
  joined: [],
  reply: "Done. The report is in reports/week.md",
  steps: [
    { kind: "shell", target: "curl -O https://example.com/report.csv" },
    { kind: "file", target: "reports/week.md" },
  ],
  ...over,
})

describe("the request for a skill from a task", () => {
  test("holds the prompt, the steps as kind and target, and the final reply", () => {
    const text = skillRequest(task())
    expect(text).toContain("Get the weekly report")
    expect(text).toContain("- shell: curl -O https://example.com/report.csv")
    expect(text).toContain("- file: reports/week.md")
    expect(text).toContain("Done. The report is in reports/week.md")
    // The last line is fixed, so a model reads it as the form of the answer.
    expect(text.endsWith("Reply with the JSON object only.")).toBe(true)
  })

  test("holds the messages that the user added during the turn", () => {
    const text = skillRequest(task({ joined: ["Use the CSV file", "Skip the summary"] }))
    expect(text).toContain("1. Use the CSV file")
    expect(text).toContain("2. Skip the summary")
    expect(skillRequest(task())).not.toContain("Messages that the user added")
  })

  test("holds nothing that the source shape leaves out", () => {
    // A caller that passes more than the shape names gets none of it into the request.
    const wide = {
      ...task(),
      output: "TOOL-OUTPUT-SECRET-TEXT",
      thinking: "THINKING-TEXT",
      page: "PAGE-TEXT",
      content: "FILE-CONTENT",
      steps: [{ kind: "shell", target: "ls", output: "TOOL-OUTPUT-SECRET-TEXT" }],
    } as unknown as SkillSource
    const text = skillRequest(wide)
    for (const left of ["TOOL-OUTPUT-SECRET-TEXT", "THINKING-TEXT", "PAGE-TEXT", "FILE-CONTENT"])
      expect(text).not.toContain(left)
    expect(text).toContain("- shell: ls")
  })

  test("a task with no steps says so", () => {
    expect(skillRequest(task({ steps: [] }))).toContain("The agent ran no steps.")
  })

  test("a task whose steps are on another computer leaves the steps out", () => {
    const text = skillRequest(task({ steps: null }))
    expect(text).not.toContain("The steps of the agent")
    expect(text).not.toContain("ran no steps")
    expect(text).toContain("Get the weekly report")
  })

  test("at most 40 steps, and the oldest are dropped first", () => {
    const steps = Array.from({ length: 55 }, (_, i) => ({ kind: "shell", target: `step-${i}` }))
    const { lines, dropped } = skillStepLines(steps)
    expect(lines).toHaveLength(SKILL_REQUEST_STEPS_MAX)
    expect(dropped).toBe(15)
    const text = skillRequest(task({ steps }))
    expect(text).not.toContain("step-14\n")
    expect(text).toContain("- shell: step-15\n")
    expect(text).toContain("- shell: step-54\n")
    expect(text).toContain("the newest 40 of 55")
  })

  test("a target is one line, cut at 200 characters", () => {
    const target = skillStepTarget("shell", `echo ${"x".repeat(400)}\nsecond line`)
    expect(length(target)).toBe(SKILL_REQUEST_TARGET_MAX)
    expect(target.endsWith("…")).toBe(true)
    expect(target).not.toContain("\n")
  })

  test("a web address is cut down to its host", () => {
    expect(skillStepTarget("web", "https://example.com/a/b?token=abc123456789")).toBe("example.com")
    // A target that is not an address stays as it is.
    expect(skillStepTarget("web", "example.com")).toBe("example.com")
  })

  test("text that looks like a secret is hidden everywhere", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz123456"
    const text = skillRequest(
      task({
        prompt: `Use the key ${key}`,
        joined: [`Bearer ${"a".repeat(30)}`],
        reply: `The token ghp_${"b".repeat(30)} works`,
        steps: [{ kind: "shell", target: `curl -H "x: ${key}" https://example.com` }],
      }),
    )
    expect(text).not.toContain(key)
    expect(text).not.toContain("a".repeat(30))
    expect(text).not.toContain("b".repeat(30))
    expect(text).toContain("[redacted]")
  })

  test("a stored value that is not of a known shape is hidden too", () => {
    const text = skillRequest(task({ reply: "The password is hunter2-very-secret" }), [
      "hunter2-very-secret",
    ])
    expect(text).not.toContain("hunter2-very-secret")
  })

  test("at most 20000 characters: the longest part is cut first", () => {
    const text = skillRequest(
      task({ prompt: "p".repeat(300), reply: "r".repeat(60_000), joined: ["j".repeat(500)] }),
    )
    expect(length(text)).toBeLessThanOrEqual(SKILL_REQUEST_MAX)
    // The short parts stay whole; the long reply is cut.
    expect(text).toContain("p".repeat(300))
    expect(text).toContain("j".repeat(500))
    expect(text).toContain("…")
    expect(text.endsWith("Reply with the JSON object only.")).toBe(true)
  })

  test("a request with several long parts stays within the limit", () => {
    const text = skillRequest(
      task({
        prompt: "p".repeat(30_000),
        reply: "r".repeat(30_000),
        joined: ["j".repeat(30_000)],
        steps: Array.from({ length: 80 }, () => ({ kind: "shell", target: "t".repeat(500) })),
      }),
    )
    expect(length(text)).toBeLessThanOrEqual(SKILL_REQUEST_MAX)
    expect(text.endsWith("Reply with the JSON object only.")).toBe(true)
  })
})

describe("the request for a skill from an article or a memory item", () => {
  test("an article gives its title, summary and body", () => {
    const text = skillRequest({
      kind: "article",
      title: "Release steps",
      summary: "How a release goes",
      body: "1. Tag the commit.\n2. Build.",
    })
    expect(text).toContain("Release steps")
    expect(text).toContain("How a release goes")
    expect(text).toContain("1. Tag the commit.")
    expect(text.endsWith("Reply with the JSON object only.")).toBe(true)
  })

  test("a memory item gives its text", () => {
    const text = skillRequest({ kind: "memory", text: "Always run the linter before a commit" })
    expect(text).toContain("Always run the linter before a commit")
    expect(text).not.toContain("The steps of the agent")
  })

  test("a long article is cut to the limit, and a secret in it is hidden", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz123456"
    const text = skillRequest({
      kind: "article",
      title: "T",
      summary: "S",
      body: `${key}\n${"b".repeat(50_000)}`,
    })
    expect(length(text)).toBeLessThanOrEqual(SKILL_REQUEST_MAX)
    expect(text).not.toContain(key)
  })

  test("a long memory text is cut to the limit", () => {
    const text = skillRequest({ kind: "memory", text: "m".repeat(40_000) })
    expect(length(text)).toBeLessThanOrEqual(SKILL_REQUEST_MAX)
  })
})

describe("cutSkillText", () => {
  test("counts characters, not code units", () => {
    expect(cutSkillText("😀😀😀😀", 3)).toBe("😀😀…")
    expect(cutSkillText("abc", 3)).toBe("abc")
    expect(cutSkillText("abc", 0)).toBe("")
  })
})

describe("the name of a draft", () => {
  const taken = (names: string[]) => (candidate: string) =>
    names.map(skillNameKey).includes(skillNameKey(candidate))

  test("a free name stays as it is, with no slash", () => {
    expect(draftName("/Weekly report", "Get it", taken([]))).toBe("Weekly report")
  })

  test("a taken name gets a number, ignoring case", () => {
    expect(draftName("weekly REPORT", "x", taken(["Weekly report"]))).toBe("weekly REPORT 2")
    expect(draftName("Weekly report", "x", taken(["Weekly report", "Weekly report 2"]))).toBe(
      "Weekly report 3",
    )
  })

  test("an answer with no name takes the title of the work", () => {
    expect(draftName("", "Release\nsteps", taken([]))).toBe("Release steps")
    expect(draftName("   ", "Release steps", taken(["release steps"]))).toBe("Release steps 2")
  })

  test("a long name is cut to 40 characters, with its number inside the limit", () => {
    const long = "x".repeat(60)
    const first = draftName(long, "", taken([]))
    expect(length(first)).toBe(SKILL_NAME_MAX)
    const second = draftName(long, "", taken([first]))
    expect(length(second)).toBeLessThanOrEqual(SKILL_NAME_MAX)
    expect(second.endsWith(" 2")).toBe(true)
  })

  test("no name and no title gives an empty name", () => {
    expect(draftName("", "", taken([]))).toBe("")
  })
})
