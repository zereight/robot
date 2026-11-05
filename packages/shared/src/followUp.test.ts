import { describe, expect, test } from "bun:test"
import {
  followUpAction,
  followUpActionKey,
  followUpDelivery,
  storedFollowUpAction,
  workingLineKey,
} from "./followUp.ts"

describe("When the working line is chosen", () => {
  describe("with a follow-up turn", () => {
    test("should say that the agent looks again", () => {
      expect(workingLineKey({ compacting: false, quiet: false, followUp: true })).toBe(
        "chat.working.followUp",
      )
    })
  })

  describe("with a quiet follow-up", () => {
    test("should keep the quiet line", () => {
      expect(workingLineKey({ compacting: false, quiet: true, followUp: true })).toBe("quiet.line")
    })
  })

  describe("with a compact during a follow-up", () => {
    test("should keep the compact line", () => {
      expect(workingLineKey({ compacting: true, quiet: false, followUp: true })).toBe(
        "chat.compacting",
      )
    })
  })

  describe("with an ordinary turn", () => {
    test("should say that the agent is working", () => {
      expect(workingLineKey({ compacting: false, quiet: false, followUp: false })).toBe(
        "chat.working",
      )
    })
  })
})

describe("When a follow-up names an action", () => {
  describe("with no action", () => {
    test("should start a new turn", () => {
      expect(followUpAction(undefined)).toBe("queue")
    })
  })

  describe("with queue or steer", () => {
    test("should keep that action", () => {
      expect(followUpAction("queue")).toBe("queue")
      expect(followUpAction("steer")).toBe("steer")
    })
  })

  describe("with another value", () => {
    test("should refuse the call", () => {
      expect(followUpAction("join")).toBeNull()
      expect(followUpAction("")).toBeNull()
      expect(followUpAction(null)).toBeNull()
    })
  })
})

describe("When a follow-up is due", () => {
  describe("with steer while this chat can take it", () => {
    test("should join that turn", () => {
      expect(followUpDelivery("steer", { runningHere: true, acceptsInput: true })).toBe("join")
    })
  })

  describe("with steer while this chat is idle", () => {
    test("should start a new turn", () => {
      expect(followUpDelivery("steer", { runningHere: false, acceptsInput: true })).toBe("task")
    })
  })

  describe("with steer while the program takes no input", () => {
    test("should start a new turn", () => {
      expect(followUpDelivery("steer", { runningHere: true, acceptsInput: false })).toBe("task")
    })
  })

  describe("with queue while this chat works", () => {
    test("should start a new turn", () => {
      expect(followUpDelivery("queue", { runningHere: true, acceptsInput: true })).toBe("task")
    })
  })
})

describe("When the details name the action", () => {
  describe("with a stored steer", () => {
    test("should say that it joins this chat", () => {
      expect(storedFollowUpAction("steer")).toBe("steer")
      expect(followUpActionKey("steer")).toBe("tasks.followUp.steer")
    })
  })

  describe("with a missing stored action", () => {
    test("should say that it starts a new turn", () => {
      expect(storedFollowUpAction(undefined)).toBe("queue")
      expect(followUpActionKey("queue")).toBe("tasks.followUp.queue")
    })
  })
})
