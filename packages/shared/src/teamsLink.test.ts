import { describe, expect, test } from "bun:test"
import {
  botListWins,
  checkTeamsLink,
  cleanNames,
  emptyTeamsFields,
  emptyTeamsView,
  holdsChatTitle,
  isLimitProblem,
  namesOfText,
  patchTouchesLocked,
  pickChat,
  problemField,
  sameTeamsName,
  TEAMS_CALL_TEXT_MAX,
  TEAMS_LIST_MAX,
  TEAMS_MARKER_DEFAULT,
  TEAMS_MARKER_MAX,
  TEAMS_NAME_MAX,
  TEAMS_TITLE_MAX,
  type TeamsFields,
  teamsLinksTo,
  teamsNameKey,
  tidyTeamsFields,
} from "./teamsLink.ts"

/** A form that passes every check. Each test breaks one thing. */
const good: TeamsFields = {
  targetKind: "agent",
  targetId: "agent-1",
  chatTitle: "Marta Kim (You)",
  chatKind: "person",
  allow: ["Marta Kim"],
  bots: [],
  callText: "",
  marker: TEAMS_MARKER_DEFAULT,
}
const ready = { signedIn: true, targetFound: true }

describe("names (spec 028, 'Name')", () => {
  test("two names are the same after spaces are trimmed and joined, and case is ignored", () => {
    expect(sameTeamsName("Marta Kim", "marta  KIM")).toBe(true)
    expect(sameTeamsName("  Marta Kim ", "Marta Kim")).toBe(true)
    expect(sameTeamsName("Marta Kim", "Marta Kimm")).toBe(false)
    // No match of a part of a name.
    expect(sameTeamsName("Marta", "Marta Kim")).toBe(false)
  })

  test("the key does not depend on how an accent is written", () => {
    expect(teamsNameKey("Jose\u0301")).toBe(teamsNameKey("Jos\u00e9"))
  })

  test("a typed list loses empty lines and repeated names, and keeps the first spelling", () => {
    expect(cleanNames(["  Marta   Kim ", "", "marta kim", "Joe Lee"])).toEqual([
      "Marta Kim",
      "Joe Lee",
    ])
    expect(namesOfText("Marta Kim\r\n\n  Joe Lee  \nMARTA KIM")).toEqual(["Marta Kim", "Joe Lee"])
  })

  test("a name in both lists is found, and the bot list wins", () => {
    expect(botListWins(["Marta Kim", "Helper Bot"], ["helper  bot"])).toBe(true)
    expect(botListWins(["Marta Kim"], ["Helper Bot"])).toBe(false)
    expect(botListWins([], [])).toBe(false)
  })
})

describe("the title of a chat", () => {
  test("a title holds the text when the text is a part of it", () => {
    expect(holdsChatTitle("Marta Kim (You)", "(you)")).toBe(true)
    expect(holdsChatTitle("Team  A", "team a")).toBe(true)
    expect(holdsChatTitle("Marta Kim", "Joe")).toBe(false)
  })

  test("an empty text holds nothing", () => {
    expect(holdsChatTitle("Marta Kim", "")).toBe(false)
    expect(holdsChatTitle("Marta Kim", "   ")).toBe(false)
  })
})

describe("which chat to open", () => {
  test("one chat in the list holds the text", () => {
    expect(pickChat(["Team A", "Team B"], null, "team b")).toEqual({
      kind: "one",
      index: 1,
      title: "Team B",
    })
  })

  test("no chat holds the text", () => {
    expect(pickChat(["Team A"], "Team A", "Project X")).toEqual({ kind: "none" })
    expect(pickChat([], null, "Project X")).toEqual({ kind: "none" })
  })

  test("more than one chat holds the text", () => {
    expect(pickChat(["Team A", "Team A"], null, "Team A")).toEqual({ kind: "many" })
    expect(pickChat(["Team A", "Team B"], null, "Team")).toEqual({ kind: "many" })
  })

  test("the open chat is the match when the list shows no chat that holds the text", () => {
    expect(pickChat(["Other"], "Marta Kim (You)", "(You)")).toEqual({
      kind: "one",
      index: null,
      title: "Marta Kim (You)",
    })
  })
})

describe("the checks of the form (the switch refuses with a reason)", () => {
  test("a full form passes", () => {
    expect(checkTeamsLink(good, ready)).toEqual([])
  })

  test("no sign-in", () => {
    expect(checkTeamsLink(good, { ...ready, signedIn: false })).toEqual(["noSignIn"])
  })

  test("no target", () => {
    expect(checkTeamsLink({ ...good, targetKind: null, targetId: null }, ready)).toEqual([
      "noTarget",
    ])
    expect(checkTeamsLink({ ...good, targetId: null }, ready)).toEqual(["noTarget"])
  })

  test("a target that is archived or gone is its own reason", () => {
    expect(checkTeamsLink(good, { ...ready, targetFound: false })).toEqual(["targetMissing"])
  })

  test("an empty chat title, and a title over 100 characters", () => {
    expect(checkTeamsLink({ ...good, chatTitle: "   " }, ready)).toEqual(["titleEmpty"])
    expect(checkTeamsLink({ ...good, chatTitle: "a".repeat(TEAMS_TITLE_MAX) }, ready)).toEqual([])
    expect(checkTeamsLink({ ...good, chatTitle: "a".repeat(TEAMS_TITLE_MAX + 1) }, ready)).toEqual([
      "titleLong",
    ])
  })

  test("the limits count the characters that the user sees", () => {
    expect(checkTeamsLink({ ...good, chatTitle: "🙂".repeat(TEAMS_TITLE_MAX) }, ready)).toEqual([])
    expect(checkTeamsLink({ ...good, marker: "🙂".repeat(TEAMS_MARKER_MAX) }, ready)).toEqual([])
  })

  test("an empty allow list, too many names, and a name that is too long", () => {
    expect(checkTeamsLink({ ...good, allow: [] }, ready)).toEqual(["allowEmpty"])
    expect(checkTeamsLink({ ...good, allow: ["", "  "] }, ready)).toEqual(["allowEmpty"])
    const twenty = Array.from({ length: TEAMS_LIST_MAX }, (_, i) => `Person ${i}`)
    expect(checkTeamsLink({ ...good, allow: twenty }, ready)).toEqual([])
    expect(checkTeamsLink({ ...good, allow: [...twenty, "Person 20"] }, ready)).toEqual([
      "allowMany",
    ])
    expect(checkTeamsLink({ ...good, allow: ["a".repeat(TEAMS_NAME_MAX)] }, ready)).toEqual([])
    expect(checkTeamsLink({ ...good, allow: ["a".repeat(TEAMS_NAME_MAX + 1)] }, ready)).toEqual([
      "allowNameLong",
    ])
  })

  test("the bot list may be empty, and it has the same limits", () => {
    expect(checkTeamsLink({ ...good, bots: [] }, ready)).toEqual([])
    const many = Array.from({ length: TEAMS_LIST_MAX + 1 }, (_, i) => `Bot ${i}`)
    expect(checkTeamsLink({ ...good, bots: many }, ready)).toEqual(["botsMany"])
    expect(checkTeamsLink({ ...good, bots: ["b".repeat(TEAMS_NAME_MAX + 1)] }, ready)).toEqual([
      "botsNameLong",
    ])
  })

  test("a name on both lists is kept, and it is no reason to refuse", () => {
    const both = { ...good, allow: ["Marta Kim"], bots: ["marta kim"] }
    expect(checkTeamsLink(both, ready)).toEqual([])
    expect(botListWins(both.allow, both.bots)).toBe(true)
  })

  test("a group chat needs the call text; a chat with one person does not", () => {
    expect(checkTeamsLink({ ...good, chatKind: "group", callText: "" }, ready)).toEqual([
      "callMissing",
    ])
    expect(checkTeamsLink({ ...good, chatKind: "group", callText: "@ROBot" }, ready)).toEqual([])
    expect(checkTeamsLink({ ...good, chatKind: "person", callText: "" }, ready)).toEqual([])
  })

  test("a call text over 40 characters", () => {
    expect(checkTeamsLink({ ...good, callText: "c".repeat(TEAMS_CALL_TEXT_MAX) }, ready)).toEqual(
      [],
    )
    expect(
      checkTeamsLink({ ...good, callText: "c".repeat(TEAMS_CALL_TEXT_MAX + 1) }, ready),
    ).toEqual(["callLong"])
  })

  test("the marker has 1 to 20 characters", () => {
    expect(checkTeamsLink({ ...good, marker: "  " }, ready)).toEqual(["markerEmpty"])
    expect(checkTeamsLink({ ...good, marker: "m".repeat(TEAMS_MARKER_MAX + 1) }, ready)).toEqual([
      "markerLong",
    ])
  })

  test("every reason is listed, in the order of the form", () => {
    expect(
      checkTeamsLink(
        { ...emptyTeamsFields, chatKind: "group", marker: "" },
        { signedIn: false, targetFound: false },
      ),
    ).toEqual(["noSignIn", "noTarget", "titleEmpty", "allowEmpty", "callMissing", "markerEmpty"])
  })

  test("each reason has a field, and a limit shows at once", () => {
    expect(problemField("noSignIn")).toBe("signIn")
    expect(problemField("titleLong")).toBe("chatTitle")
    expect(problemField("callMissing")).toBe("callText")
    expect(isLimitProblem("allowMany")).toBe(true)
    expect(isLimitProblem("callLong")).toBe(true)
    expect(isLimitProblem("noTarget")).toBe(false)
    expect(isLimitProblem("titleEmpty")).toBe(false)
  })

  test("the form is kept trimmed, with clean lists", () => {
    const kept = tidyTeamsFields({
      ...good,
      chatTitle: "  Chat ",
      allow: [" A ", "a", ""],
      callText: " @ROBot ",
      marker: " [R] ",
    })
    expect(kept.chatTitle).toBe("Chat")
    expect(kept.allow).toEqual(["A"])
    expect(kept.callText).toBe("@ROBot")
    expect(kept.marker).toBe("[R]")
  })
})

describe("what changes while the switch is on", () => {
  test("the target, the chat title, the kind and the marker are locked", () => {
    expect(patchTouchesLocked({ targetId: "other" }, good)).toBe(true)
    expect(patchTouchesLocked({ chatTitle: "Other" }, good)).toBe(true)
    expect(patchTouchesLocked({ chatKind: "group" }, good)).toBe(true)
    expect(patchTouchesLocked({ marker: "[X]" }, good)).toBe(true)
    expect(patchTouchesLocked({ targetKind: "channel" }, good)).toBe(true)
  })

  test("the lists and the call text change at any time", () => {
    expect(patchTouchesLocked({ allow: ["Joe Lee"] }, good)).toBe(false)
    expect(patchTouchesLocked({ bots: ["Helper Bot"] }, good)).toBe(false)
    expect(patchTouchesLocked({ callText: "@ROBot" }, good)).toBe(false)
  })

  test("a field with the value it has is no change", () => {
    expect(
      patchTouchesLocked({ marker: TEAMS_MARKER_DEFAULT, chatTitle: good.chatTitle }, good),
    ).toBe(false)
  })
})

describe("the link of a place", () => {
  test("it is for the agent or the channel it names, and only when it exists", () => {
    const view = { ...emptyTeamsView, exists: true, fields: good }
    expect(teamsLinksTo(view, "agent", "agent-1")).toBe(true)
    expect(teamsLinksTo(view, "channel", "agent-1")).toBe(false)
    expect(teamsLinksTo(view, "agent", "agent-2")).toBe(false)
    expect(teamsLinksTo(emptyTeamsView, "agent", "agent-1")).toBe(false)
  })
})
