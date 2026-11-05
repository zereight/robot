import { describe, expect, test } from "bun:test"
import {
  cleanEventSummary,
  cutEventDetail,
  EVENT_DETAIL_MAX,
  EVENT_SUMMARY_MAX,
  eventResultKey,
  eventSourceKey,
  subjectWaits,
  testEventGone,
  validEventSubject,
} from "./events.ts"

describe("the summary line of an event", () => {
  describe("with line breaks and runs of spaces", () => {
    test("it becomes one line", () => {
      expect(cleanEventSummary("  a\n\nb   c  ")).toBe("a b c")
    })
  })

  describe("with more characters than the limit", () => {
    test("it is cut and marked", () => {
      const long = "x".repeat(EVENT_SUMMARY_MAX + 50)
      const line = cleanEventSummary(long)
      expect(line).toBe(`${"x".repeat(EVENT_SUMMARY_MAX - 1)}…`)
      expect([...line]).toHaveLength(EVENT_SUMMARY_MAX)
    })
  })

  describe("with nothing but spaces", () => {
    test("it is empty", () => {
      expect(cleanEventSummary("   \n ")).toBe("")
    })
  })
})

describe("the detail of an event", () => {
  describe("with more characters than the limit", () => {
    test("it is cut and marked", () => {
      const long = "y".repeat(EVENT_DETAIL_MAX + 10)
      expect([...cutEventDetail(long)]).toHaveLength(EVENT_DETAIL_MAX)
      expect(cutEventDetail(long).endsWith("…")).toBe(true)
    })
  })

  describe("with fewer characters than the limit", () => {
    test("it is not changed", () => {
      expect(cutEventDetail("short")).toBe("short")
    })
  })
})

describe("the subject of an event", () => {
  describe("with letters, digits and the allowed marks", () => {
    test("it is valid", () => {
      expect(validEventSubject("owner/app#12")).toBe(true)
      expect(validEventSubject("a.b_c:d/e@f-g")).toBe(true)
    })
  })

  describe("with an empty subject", () => {
    test("it is not valid", () => {
      expect(validEventSubject("")).toBe(false)
    })
  })

  describe("with a mark that the form does not allow", () => {
    test("it is not valid", () => {
      expect(validEventSubject("a b")).toBe(false)
      expect(validEventSubject("a?b")).toBe(false)
    })
  })

  describe("with more characters than the limit", () => {
    test("it is not valid", () => {
      expect(validEventSubject("a".repeat(101))).toBe(false)
    })
  })
})

describe("work of one subject", () => {
  describe("with a message of an outside program", () => {
    test("it waits in turn", () => {
      expect(subjectWaits("outside_program")).toBe(true)
    })
  })

  describe("with a schedule, a watch or a web hook", () => {
    test("it keeps its own rule", () => {
      expect(subjectWaits("schedule")).toBe(false)
      expect(subjectWaits("watch")).toBe(false)
      expect(subjectWaits("web_hook")).toBe(false)
    })
  })
})

describe("words for the page", () => {
  describe("of a result and a source", () => {
    test("each one has its own key", () => {
      expect(eventResultKey("routed")).toBe("events.result.routed")
      expect(eventSourceKey("web_hook")).toBe("events.source.web_hook")
    })
  })
})

describe("a test event", () => {
  const event = (source: "test" | "schedule", at: number) => ({
    id: "e",
    serverId: "s",
    source,
    type: { text: "t" },
    subject: null,
    callId: null,
    summary: { text: "s" },
    detail: "",
    link: null,
    agentId: null,
    placeId: null,
    placeIsRoutine: false,
    placeName: null,
    why: { key: "events.test.wouldGo", params: { place: "p" } },
    got: "",
    taskId: null,
    result: "would_go" as const,
    reason: null,
    outside: false,
    at,
  })

  describe("that is more than a day old", () => {
    test("it has left the page", () => {
      const now = 10 * 24 * 60 * 60 * 1000
      expect(testEventGone(event("test", 0), now)).toBe(true)
    })
  })

  describe("that is less than a day old", () => {
    test("it stays", () => {
      const now = 60 * 60 * 1000
      expect(testEventGone(event("test", 0), now)).toBe(false)
    })
  })

  describe("of a schedule that is a day old", () => {
    test("it stays, because only a test event leaves", () => {
      const now = 10 * 24 * 60 * 60 * 1000
      expect(testEventGone(event("schedule", 0), now)).toBe(false)
    })
  })
})
