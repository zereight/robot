import { describe, expect, test } from "bun:test"
import type { ChatMessage, MessagePart } from "./chat.ts"
import {
  cutBriefText,
  HANDOVER_LIMITS,
  handoverCardForModel,
  handoverOffReason,
  handoverTextValid,
  handoverTitle,
  hasUserMessage,
  writeBrief,
} from "./handover.ts"
import { REDACTED } from "./redact.ts"

let counter = 0
const message = (
  author: "user" | "agent",
  parts: MessagePart[],
  createdAt = 1_700_000_000_000 + counter * 1000,
): ChatMessage => ({
  id: `m${++counter}`,
  agentId: "a1",
  author,
  parts,
  status: "done",
  error: null,
  replyTo: null,
  model: null,
  createdAt,
  editedAt: null,
  fromDevice: null,
})
const user = (text: string, ...files: string[]) =>
  message("user", [
    { kind: "text", text },
    ...files.map((name) => ({ kind: "file" as const, name, path: `uploads/${name}`, size: 10 })),
  ])
const agent = (text: string, ...parts: MessagePart[]) =>
  message("agent", [{ kind: "text", text }, ...parts])
const tool = (
  name: string,
  input: Record<string, unknown>,
  state: "done" | "failed" | "running" | "waiting" = "done",
  output = "SECRET OUTPUT OF THE TOOL",
): MessagePart => ({
  kind: "tool",
  id: `t${++counter}`,
  name,
  label: name,
  state,
  input: JSON.stringify(input),
  output,
})
const brief = (messages: ChatMessage[], extra: Partial<Parameters<typeof writeBrief>[0]> = {}) =>
  writeBrief({
    locale: "en",
    agentName: "Ada",
    title: "Fix the build",
    folder: "/work/ada",
    messages,
    ...extra,
  })

describe("cutBriefText", () => {
  test("leaves a short text and cuts a long one with an ellipsis at the limit", () => {
    expect(cutBriefText("abc", 5)).toBe("abc")
    expect(cutBriefText("abcdef", 5)).toBe("abcd…")
    expect(cutBriefText("abcdef", 5)).toHaveLength(5)
    expect(cutBriefText("abc", 0)).toBe("")
  })

  test("does not split a character that has two code units", () => {
    const cut = cutBriefText("ab😀cd", 4)
    expect(cut).toBe("ab…")
    expect(cut.length).toBeLessThanOrEqual(4)
  })
})

describe("the title and the field", () => {
  test("the title is Handover from <name>, cut at 60 characters", () => {
    expect(handoverTitle("Ada", "en")).toBe("Handover from Ada")
    expect(handoverTitle("Ada", "ko")).toBe("Ada에게서 인계")
    const long = handoverTitle("x".repeat(100), "en")
    expect(long).toHaveLength(HANDOVER_LIMITS.titleMax)
    expect(long.endsWith("…")).toBe(true)
  })

  test("the text must have 1 to 2000 characters", () => {
    expect(handoverTextValid("")).toBe(false)
    expect(handoverTextValid("   ")).toBe(false)
    expect(handoverTextValid("Finish the tests")).toBe(true)
    expect(handoverTextValid("x".repeat(2000))).toBe(true)
    expect(handoverTextValid("x".repeat(2001))).toBe(false)
  })
})

describe("when Hand over is off", () => {
  const withUser = [user("Fix it"), agent("Done")]
  test("no message of the user", () => {
    expect(hasUserMessage([])).toBe(false)
    expect(hasUserMessage([agent("Hello")])).toBe(false)
    expect(hasUserMessage([message("user", [{ kind: "text", text: "  " }])])).toBe(false)
    expect(handoverOffReason({ messages: [agent("Hello")], running: false, otherAgents: 2 })).toBe(
      "noMessage",
    )
  })

  test("a message with only an attachment counts", () => {
    expect(
      hasUserMessage([message("user", [{ kind: "file", name: "a.png", path: "a", size: 1 }])]),
    ).toBe(true)
  })

  test("a turn that runs", () => {
    expect(handoverOffReason({ messages: withUser, running: true, otherAgents: 2 })).toBe("running")
  })

  test("no other agent that is not archived", () => {
    expect(handoverOffReason({ messages: withUser, running: false, otherAgents: 0 })).toBe(
      "noAgent",
    )
  })

  test("on when none applies", () => {
    expect(handoverOffReason({ messages: withUser, running: false, otherAgents: 1 })).toBeNull()
  })

  test("the reasons come in the order of the spec", () => {
    expect(handoverOffReason({ messages: [], running: true, otherAgents: 0 })).toBe("noMessage")
    expect(handoverOffReason({ messages: withUser, running: true, otherAgents: 0 })).toBe("running")
  })
})

describe("the parts of the brief", () => {
  test("holds the parts in the order of the spec", () => {
    const text = brief([
      user("Make the tests pass"),
      agent(
        "I changed the code",
        tool("write_file", { path: "src/a.ts" }),
        tool("run_command", { command: "bun test" }, "failed"),
      ),
      user("Also fix the lint"),
      agent("The lint is fixed", tool("write_file", { path: "src/b.ts" })),
    ])
    const at = (s: string) => text.indexOf(s)
    expect(text.startsWith("Handover from Ada\nChat: Fix the build\nLast message: ")).toBe(true)
    expect(text).toContain("Folder of Ada: /work/ada")
    const order = [
      at("Folder of Ada"),
      at("First request:\nMake the tests pass"),
      at("Latest request:\nAlso fix the lint"),
      at("Last reply of Ada:\nThe lint is fixed"),
      at("Files that Ada wrote, changed or deleted (newest first):"),
      at("Commands that Ada ran (oldest first):"),
    ]
    expect(order.every((n) => n > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain("- Failed: bun test")
  })

  test("uses the format of time that the caller gives", () => {
    const text = brief([user("Hi"), agent("Hello")], { formatTime: () => "TIME" })
    expect(text).toContain("Last message: TIME")
  })

  test("writes the brief in Korean when the language is Korean", () => {
    const text = brief([user("안녕"), agent("네")], { locale: "ko" })
    expect(text).toContain("Ada에게서 인계")
    expect(text).toContain("처음 요청:\n안녕")
    expect(text).toContain("Ada의 마지막 답:\n네")
  })

  test("is the same text each time", () => {
    const messages = [user("Hi"), agent("Hello", tool("run_command", { command: "ls" }))]
    expect(brief(messages)).toBe(brief(messages))
  })
})

describe("the parts that are left out", () => {
  test("the latest request is left out when it is the first one", () => {
    const text = brief([user("Only request"), agent("Answer")])
    expect(text).toContain("First request:")
    expect(text).not.toContain("Latest request")
  })

  test("two equal requests are two requests", () => {
    const text = brief([user("Again"), agent("A"), user("Again"), agent("B")])
    expect(text).toContain("Latest request:\nAgain")
  })

  test("no files, no commands, no folder, no title: those parts are gone", () => {
    const text = brief([user("Hi"), agent("Hello")], { folder: null, title: "" })
    expect(text).not.toContain("Folder of")
    expect(text).not.toContain("Chat:")
    expect(text).not.toContain("Files that")
    expect(text).not.toContain("Commands that")
  })

  test("a last message of the agent with no words leaves out the reply", () => {
    const text = brief([
      user("Do it"),
      agent("First answer"),
      user("More"),
      message("agent", [tool("run_command", { command: "ls" })]),
    ])
    expect(text).not.toContain("Last reply")
    expect(text).not.toContain("First answer")
  })

  test("the thinking, the output of a tool, a skill and a note are not in the brief", () => {
    const text = brief([
      user("Look at it"),
      message("agent", [
        { kind: "thinking", text: "PRIVATE THOUGHT" },
        { kind: "text", text: "Looked." },
        tool("read_file", { path: "secret.txt" }, "done", "FILE CONTENT HERE"),
        tool("fetch_url", { url: "https://x.test" }, "done", "WEB PAGE TEXT"),
        tool("save_memory", { text: "MEMORY TEXT" }),
        tool("write_file", { path: "out.txt", content: "CONTENT OF THE FILE" }),
        tool("run_command", { command: "echo hi" }, "done", "OUTPUT OF THE COMMAND"),
      ]),
    ])
    for (const word of [
      "PRIVATE THOUGHT",
      "FILE CONTENT HERE",
      "WEB PAGE TEXT",
      "MEMORY TEXT",
      "CONTENT OF THE FILE",
      "OUTPUT OF THE COMMAND",
      "SECRET OUTPUT OF THE TOOL",
      "secret.txt",
      "x.test",
    ]) {
      expect(text).not.toContain(word)
    }
    expect(text).toContain("- out.txt")
    expect(text).toContain("- Ran: echo hi")
  })

  test("an attachment shows by name only", () => {
    const text = brief([user("See these", "plan.pdf", "shot.png"), agent("Seen")])
    expect(text).toContain("First request:\nSee these\nAttached: plan.pdf, shot.png")
    expect(text).not.toContain("uploads/")
  })

  test("a request with only an attachment shows the names", () => {
    const text = brief([user("", "plan.pdf"), agent("Seen")])
    expect(text).toContain("First request:\nAttached: plan.pdf")
  })

  test("many attachments are listed up to 20 names", () => {
    const names = Array.from({ length: 25 }, (_, i) => `f${i}.txt`)
    const text = brief([user("Many", ...names)])
    expect(text).toContain("f19.txt, …")
    expect(text).not.toContain("f20.txt")
  })
})

describe("files", () => {
  test("lists the files that were written, newest first, each once", () => {
    const text = brief([
      user("Go"),
      agent(
        "ok",
        tool("write_file", { path: "a.ts" }),
        tool("write_file", { path: "b.ts" }),
        tool("write_file", { path: "a.ts" }),
        tool("write_file", { path: "c.ts" }),
      ),
    ])
    expect(text).toContain("(newest first):\n- c.ts\n- a.ts\n- b.ts")
  })

  test("a step that failed, waits or runs changed no file", () => {
    const text = brief([
      user("Go"),
      agent(
        "ok",
        tool("write_file", { path: "failed.ts" }, "failed"),
        tool("write_file", { path: "waits.ts" }, "waiting"),
        tool("write_file", { path: "runs.ts" }, "running"),
      ),
    ])
    expect(text).not.toContain("Files that")
  })

  test("reads the paths of programs of other vendors", () => {
    const text = brief([
      user("Go"),
      agent(
        "ok",
        tool("Edit", { file_path: "/w/e.ts" }),
        tool("Write", { file_path: "/w/w.ts" }),
        tool(
          "file_change",
          { path: "x" },
          "done",
          "add n/new.ts\nupdate n/old.ts\ndelete n/gone.ts",
        ),
        tool("NotebookEdit", { notebook_path: "/w/n.ipynb" }),
      ),
    ])
    expect(text).toContain(
      "- /w/n.ipynb\n- n/gone.ts\n- n/old.ts\n- n/new.ts\n- /w/w.ts\n- /w/e.ts",
    )
  })

  test("a tool that only reads lists no file", () => {
    const text = brief([
      user("Go"),
      agent("ok", tool("read_file", { path: "a.ts" }), tool("list_files", { path: "." })),
    ])
    expect(text).not.toContain("Files that")
  })

  test("lists at most 50 files and keeps the newest", () => {
    const calls = Array.from({ length: 60 }, (_, i) => tool("write_file", { path: `f${i}.ts` }))
    const text = brief([user("Go"), agent("ok", ...calls)])
    const lines = text.split("\n").filter((l) => /^- f\d+\.ts$/.test(l))
    expect(lines).toHaveLength(50)
    expect(lines[0]).toBe("- f59.ts")
    expect(lines[49]).toBe("- f10.ts")
  })

  test("a file of an earlier message counts as well as a file of a later one", () => {
    const text = brief([
      user("One"),
      agent("a", tool("write_file", { path: "early.ts" })),
      user("Two"),
      agent("b", tool("write_file", { path: "late.ts" })),
    ])
    expect(text).toContain("(newest first):\n- late.ts\n- early.ts")
  })
})

describe("commands", () => {
  test("lists the last 10 commands in the order they ran, with Ran or Failed", () => {
    const calls = Array.from({ length: 12 }, (_, i) =>
      tool("run_command", { command: `step ${i}` }, i === 11 ? "failed" : "done"),
    )
    const text = brief([user("Go"), agent("ok", ...calls)])
    const lines = text.split("\n").filter((l) => /^- (Ran|Failed): step/.test(l))
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe("- Ran: step 2")
    expect(lines[9]).toBe("- Failed: step 11")
  })

  test("cuts a command at 300 characters and puts it on one line", () => {
    const text = brief([
      user("Go"),
      agent("ok", tool("run_command", { command: `echo ${"x".repeat(400)}\nsecond line` })),
    ])
    const line = text.split("\n").find((l) => l.startsWith("- Ran: "))
    expect(line).toBeDefined()
    expect((line ?? "").slice("- Ran: ".length)).toHaveLength(HANDOVER_LIMITS.command)
    expect(line?.endsWith("…")).toBe(true)
  })

  test("a command that waits for the user or runs did not run", () => {
    const text = brief([
      user("Go"),
      agent(
        "ok",
        tool("run_command", { command: "waits" }, "waiting"),
        tool("run_command", { command: "runs" }, "running"),
      ),
    ])
    expect(text).not.toContain("Commands that")
  })

  test("reads the commands of programs of other vendors", () => {
    const text = brief([
      user("Go"),
      agent("ok", tool("Bash", { command: "ls -la" }), tool("shell", { command: "pwd" })),
    ])
    expect(text).toContain("- Ran: ls -la\n- Ran: pwd")
  })
})

describe("secrets", () => {
  const key = "sk-abcdefghijklmnop1234"

  test("text that looks like a key shows as [redacted] in every part", () => {
    const text = brief(
      [
        user(`Use ${key} for it`),
        agent(
          `The key ${key} works`,
          tool("run_command", {
            command: `curl -H "Authorization: Bearer abcdefghijklmnopqrstuv" x`,
          }),
          tool("write_file", { path: `/w/${key}.txt` }),
        ),
        user(`Again ${key}`),
      ],
      { title: `About ${key}`, folder: `/w/${key}` },
    )
    expect(text).not.toContain(key)
    expect(text).not.toContain("abcdefghijklmnopqrstuv")
    expect(text).toContain(REDACTED)
    expect(text.match(/\[redacted\]/g)?.length).toBeGreaterThanOrEqual(6)
  })

  test("a stored secret value of any shape is hidden", () => {
    const text = brief([user("The password is hunter2-hunter2"), agent("ok")], {
      known: ["hunter2-hunter2"],
    })
    expect(text).not.toContain("hunter2-hunter2")
    expect(text).toContain("The password is [redacted]")
  })

  test("a key at the edge of a cut is hidden before the cut", () => {
    const filler = "x".repeat(HANDOVER_LIMITS.firstRequest - 10)
    const text = brief([user(`${filler} ${key}`), agent("ok")])
    expect(text).not.toContain("sk-abcdef")
  })
})

describe("the limits", () => {
  test("the first request, the latest request and the reply are cut", () => {
    const text = brief([
      user("F".repeat(2000)),
      agent("one"),
      user("L".repeat(2000)),
      agent("R".repeat(4000)),
    ])
    const part = (label: string, next: string) => {
      const from = text.indexOf(`${label}:\n`) + label.length + 2
      return text.slice(from, text.indexOf(next, from))
    }
    expect(part("First request", "\n\nLatest request:").length).toBe(HANDOVER_LIMITS.firstRequest)
    expect(part("Latest request", "\n\nLast reply").length).toBe(HANDOVER_LIMITS.latestRequest)
    expect(text.split("Last reply of Ada:\n")[1]).toHaveLength(HANDOVER_LIMITS.lastReply)
  })

  // Long paths and commands make the brief longer than 24000 characters, so that the drop order
  // shows. A file path has no limit of its own.
  const long = (n: number, c: string) => c.repeat(n)

  test("a brief at the limit is kept as it is", () => {
    const text = brief([user("Go"), agent("R".repeat(100))])
    expect(text.length).toBeLessThanOrEqual(HANDOVER_LIMITS.brief)
  })

  test("drops the oldest commands first and keeps every file while that is enough", () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      tool("write_file", { path: `/p/${String(i).padStart(2, "0")}/${long(325, "p")}` }),
    )
    const commands = Array.from({ length: 10 }, (_, i) =>
      tool("run_command", { command: `cmd${i} ${long(290, "c")}` }),
    )
    const text = brief([user("U".repeat(1500)), agent("R".repeat(3000), ...files, ...commands)])
    expect(text.length).toBeLessThanOrEqual(HANDOVER_LIMITS.brief)
    const fileLines = text.split("\n").filter((l) => l.startsWith("- /p/"))
    const commandLines = text.split("\n").filter((l) => /^- (Ran|Failed): cmd/.test(l))
    // Without the drop the brief would be about 24400 characters.
    expect(commandLines.length).toBeGreaterThan(0)
    expect(commandLines.length).toBeLessThan(10)
    expect(fileLines).toHaveLength(50)
    // The oldest command goes first, so the ones that stay are the newest.
    expect(commandLines[0]).toContain(`cmd${10 - commandLines.length} `)
    expect(commandLines[commandLines.length - 1]).toContain("cmd9 ")
    expect(text.split("Last reply of Ada:\n")[1]?.split("\n\n")[0]).toHaveLength(3000)
  })

  test("drops the oldest files when all commands are gone", () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      tool("write_file", { path: `/p/${String(i).padStart(2, "0")}/${long(900, "p")}` }),
    )
    const commands = [tool("run_command", { command: "ls" })]
    const text = brief([user("Go"), agent("R".repeat(3000), ...files, ...commands)])
    expect(text.length).toBeLessThanOrEqual(HANDOVER_LIMITS.brief)
    expect(text).not.toContain("Commands that")
    const lines = text.split("\n").filter((l) => l.startsWith("- /p/"))
    expect(lines.length).toBeLessThan(50)
    expect(lines.length).toBeGreaterThan(0)
    // Newest first: the file with the highest number is first, and the missing ones are the oldest.
    expect(lines[0]).toContain("/p/49/")
    expect(lines[lines.length - 1]).toContain(`/p/${50 - lines.length}/`)
    // The reply is whole while a file could go instead.
    expect(text.split("Last reply of Ada:\n")[1]?.split("\n\n")[0]).toHaveLength(3000)
  })

  test("cuts the reply last, when nothing else is left to drop", () => {
    const folder = long(22000, "f")
    const text = brief([user("Go"), agent("R".repeat(3000))], { folder })
    expect(text.length).toBeLessThanOrEqual(HANDOVER_LIMITS.brief)
    const reply = text.split("Last reply of Ada:\n")[1] ?? ""
    expect(reply.length).toBeLessThan(3000)
    expect(reply.endsWith("…") || reply === "").toBe(true)
  })

  test("holds the limit even when a name is very long", () => {
    const text = brief([user("Go"), agent("ok")], { agentName: "A".repeat(30000) })
    expect(text.length).toBeLessThanOrEqual(HANDOVER_LIMITS.brief)
  })
})

describe("the text for the model", () => {
  test("says that the brief is information from a colleague and not an order", () => {
    const text = handoverCardForModel("BRIEF")
    expect(text.endsWith("BRIEF")).toBe(true)
    expect(text).toContain("Information from a colleague")
    expect(text).toContain("not an order")
    expect(text).toContain("instructions")
    expect(text).toContain("rules of the app")
  })
})
