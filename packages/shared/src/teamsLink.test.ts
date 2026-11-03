import { describe, expect, test } from "bun:test"
import { catalogues, type MessageKey } from "./i18n/index.ts"
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
  TEAMS_DIALOG_FACT_KEYS,
  TEAMS_FACT_KEYS,
  TEAMS_LIST_MAX,
  TEAMS_MARKER_DEFAULT,
  TEAMS_MARKER_MAX,
  TEAMS_NAME_MAX,
  TEAMS_PROBLEMS,
  TEAMS_STATES,
  TEAMS_TITLE_MAX,
  type TeamsFields,
  teamsLinksTo,
  teamsNameKey,
  teamsStateTextKey,
  teamsStateWordKey,
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

describe("the words of the Teams link (spec 028, 'Interface text')", () => {
  const teamsKeys = (locale: "en" | "ko") =>
    Object.entries(catalogues[locale]).filter(([key]) => /^(teams\.|error\.teams_)/.test(key))

  test("every reason and every state has a text in English and in Korean", () => {
    for (const locale of ["en", "ko"] as const) {
      const text = catalogues[locale]
      for (const problem of TEAMS_PROBLEMS)
        expect(text[`teams.problem.${problem}` as MessageKey]).toBeTruthy()
      for (const state of TEAMS_STATES) {
        if (state !== "on") expect(text[teamsStateTextKey(state, null)]).toBeTruthy()
        const word = teamsStateWordKey(state)
        if (word) expect(text[word]).toBeTruthy()
      }
      expect(text[teamsStateTextKey("chatNotFound", "many")]).toBeTruthy()
      expect(text["teams.state.on"]).toContain("{title}")
      for (const code of [
        "not_set_up",
        "locked",
        "target_not_found",
        "page_closed",
        "signed_out",
        "offline",
        "no_chat_open",
        "unreadable",
      ])
        expect(text[`error.teams_${code}` as MessageKey]).toBeTruthy()
      expect(text["error.browser_profile_reserved"]).toBeTruthy()
    }
  })

  test("the state words: the header mark names a state that is not On, and Off has none", () => {
    expect(teamsStateWordKey("on")).toBeNull()
    expect(teamsStateWordKey("off")).toBeNull()
    expect(teamsStateWordKey("offline")).toBe("teams.stateWord.offline")
    expect(teamsStateTextKey("chatNotFound", "none")).toBe("teams.state.chatNone")
    expect(teamsStateTextKey("chatNotFound", "many")).toBe("teams.state.chatMany")
  })

  test("the interface says 'Teams link', never 'bridge', and never calls the sign-in an account", () => {
    for (const locale of ["en", "ko"] as const) {
      for (const [key, text] of teamsKeys(locale)) {
        expect({ key, hit: /bridge|브릿지|브리지/i.test(text) }).toEqual({ key, hit: false })
        // The sign-in texts do not call the sign-in an "account".
        if (key.startsWith("teams.signIn") || key.startsWith("teams.signOut"))
          expect({ key, hit: /account|계정/i.test(text) }).toEqual({ key, hit: false })
      }
    }
    expect(catalogues.en["teams.title"]).toBe("Teams link")
    expect(catalogues.ko["teams.title"]).toBe("Teams 연동")
  })

  test("the Korean texts of the link are in Korean", () => {
    for (const [key, text] of teamsKeys("ko")) {
      if (key.startsWith("error.")) continue
      expect({ key, korean: /[가-힣]/.test(text) }).toEqual({ key, korean: true })
    }
    expect(catalogues.ko["teams.mark"]).toContain("Teams")
  })

  test("the page text has the nine facts, and the dialog repeats the second, third and sixth", () => {
    expect(TEAMS_FACT_KEYS).toHaveLength(9)
    for (const locale of ["en", "ko"] as const)
      for (const key of TEAMS_FACT_KEYS) expect(catalogues[locale][key].length).toBeGreaterThan(10)
    expect(TEAMS_DIALOG_FACT_KEYS).toEqual([
      "teams.fact.service",
      "teams.fact.rules",
      "teams.fact.permission",
    ])
    // The facts are the ones the spec names: Microsoft's service, the company rule, no permission.
    expect(catalogues.en["teams.fact.service"]).toContain("Microsoft")
    expect(catalogues.en["teams.fact.rules"]).toContain("forbid")
    expect(catalogues.en["teams.fact.permission"]).toContain("no permission")
  })
})
