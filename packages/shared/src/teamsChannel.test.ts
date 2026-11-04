import { describe, expect, test } from "bun:test"
import type { MessagePart } from "./chat.ts"
import {
  isTeamsJobKind,
  type JobMessage,
  jobName,
  leadReply,
  memberAnswer,
  memberReply,
  partHoldsJobBack,
  waitingKey,
} from "./teamsChannel.ts"

const text = (value: string): MessagePart => ({ kind: "text", text: value })
const file = (name: string): MessagePart => ({
  kind: "file",
  name,
  path: `attachments/${name}`,
  size: 1,
})
const message = (kind: JobMessage["kind"], ...parts: MessagePart[]): JobMessage => ({ kind, parts })

describe("the reply of the lead", () => {
  test("a lead that made parts gives the summary, not the plan", () => {
    const reply = leadReply([
      message("plan", text("Plan: two steps")),
      message("text", text("Cy: please check the copy")),
      message("summary", text("Both parts are done.")),
    ])
    expect(reply).toEqual({ text: "Both parts are done.", files: 0 })
  })

  test("the newest summary counts", () => {
    const reply = leadReply([message("summary", text("old")), message("summary", text("new"))])
    expect(reply.text).toBe("new")
  })

  test("a plan with no summary gives no reply text, and never the plan", () => {
    expect(leadReply([message("plan", text("Plan: one step"))])).toEqual({ text: "", files: 0 })
    expect(leadReply([message("plan", text("Plan")), message("text", text("a nudge"))])).toEqual({
      text: "",
      files: 0,
    })
  })

  test("a lead that made no parts gives its reply text", () => {
    expect(leadReply([message("text", text("It is done."))])).toEqual({
      text: "It is done.",
      files: 0,
    })
  })

  test("the files of the reply are counted, and no file text goes", () => {
    const reply = leadReply([
      message("summary", text("See the files."), file("a.png"), file("b.png")),
    ])
    expect(reply).toEqual({ text: "See the files.", files: 2 })
  })

  test("no message gives no reply text", () => {
    expect(leadReply([])).toEqual({ text: "", files: 0 })
  })
})

describe("the reply of a member", () => {
  test("it is the newest text message of the member", () => {
    expect(
      memberReply([message("text", text("first")), message("text", text("second"))]).text,
    ).toBe("second")
  })

  test("a tool card or a thinking part adds no words", () => {
    const reply = memberReply([
      message(
        "text",
        { kind: "thinking", text: "hmm" } as MessagePart,
        text("Answer."),
        file("x.png"),
      ),
    ])
    expect(reply).toEqual({ text: "Answer.", files: 1 })
  })

  test("no message gives no reply text", () => {
    expect(memberReply([])).toEqual({ text: "", files: 0 })
  })
})

describe("the answer of a member", () => {
  test("it holds the name of the member, a colon and the reply text", () => {
    expect(memberAnswer("en", "Cy", "Ready.")).toBe("Cy: Ready.")
    expect(memberAnswer("ko", "Cy", "준비됐어요.")).toBe("Cy: 준비됐어요.")
  })

  test("a reply text that looks like a place holder is kept as it is", () => {
    expect(memberAnswer("en", "Cy", "use {name} and {text}")).toBe("Cy: use {name} and {text}")
  })
})

describe("the name in a line", () => {
  test("a request that the lead read names the channel; a member that was chosen names itself", () => {
    expect(jobName("lead", "Launch", "Cy")).toBe("Launch")
    expect(jobName("mention", "Launch", "Cy")).toBe("Cy")
  })
})

describe("a part that holds the job back", () => {
  test("a part in review does, while the job is open", () => {
    expect(partHoldsJobBack({ state: "review", replaced: false, jobOpen: true })).toBe(true)
  })

  test("a failed or blocked part does, until a later try replaces it", () => {
    expect(partHoldsJobBack({ state: "failed", replaced: false, jobOpen: true })).toBe(true)
    expect(partHoldsJobBack({ state: "blocked", replaced: false, jobOpen: true })).toBe(true)
    expect(partHoldsJobBack({ state: "failed", replaced: true, jobOpen: true })).toBe(false)
  })

  test("a part that runs, is done or was stopped does not", () => {
    for (const state of ["queued", "running", "waiting", "done", "cancelled"] as const)
      expect(partHoldsJobBack({ state, replaced: false, jobOpen: true })).toBe(false)
  })

  test("a job that is not open holds nothing: it gave its answer, or a restart stopped it", () => {
    expect(partHoldsJobBack({ state: "review", replaced: false, jobOpen: false })).toBe(false)
    expect(partHoldsJobBack({ state: "failed", replaced: false, jobOpen: false })).toBe(false)
  })
})

describe("the keys of the cards", () => {
  test("a card, a part and a pick request never share a key", () => {
    const keys = [
      waitingKey.card("agent-1", "call-1"),
      waitingKey.part("agent-1"),
      waitingKey.pick("agent-1"),
    ]
    expect(new Set(keys).size).toBe(3)
  })
})

describe("the kind of a job", () => {
  test("only lead and mention are kinds", () => {
    expect(isTeamsJobKind("lead")).toBe(true)
    expect(isTeamsJobKind("mention")).toBe(true)
    expect(isTeamsJobKind("teams")).toBe(false)
    expect(isTeamsJobKind(null)).toBe(false)
  })
})
