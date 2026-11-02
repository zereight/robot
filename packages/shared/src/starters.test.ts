import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AGENT_NAME_MAX, AGENT_ROLE_MAX, charLength } from "./agents.ts"
import { placeholders, translate } from "./i18n/index.ts"
import { ROUTINE_NAME_MAX, ROUTINE_PROMPT_MAX } from "./routines.ts"
import { validSchedule } from "./schedule.ts"
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  skillName,
  skillProblems,
} from "./skills.ts"
import {
  AgentStarterCreate,
  STARTER_PLANS,
  STARTER_ROUTINE_SCHEDULE,
  STARTERS,
  StarterSetup,
} from "./starters.ts"
import { starterExtras, starterSetup, starterText } from "./starterText.ts"

const LOCALES = ["en", "ko"] as const
const HANGUL = /[\u3131-\uD79D]/

describe("starters", () => {
  test("the list has the five starters, in the order of the spec", () => {
    expect([...STARTERS]).toEqual(["assistant", "briefer", "researcher", "reviewer", "organizer"])
  })

  for (const locale of LOCALES) {
    for (const id of STARTERS) {
      test(`${id} in ${locale}: every text is there and fits its limit`, () => {
        const text = starterText(locale, id)
        const plan = STARTER_PLANS[id]
        expect(charLength(text.name)).toBeGreaterThanOrEqual(1)
        expect(charLength(text.name)).toBeLessThanOrEqual(AGENT_NAME_MAX)
        expect(text.job.length).toBeGreaterThan(0)
        expect(text.role.length).toBeGreaterThan(0)
        expect(charLength(text.role)).toBeLessThanOrEqual(AGENT_ROLE_MAX)
        expect(text.instructions.length).toBeGreaterThan(0)
        expect(text.routine !== null).toBe(plan.routine)
        expect(text.skill !== null).toBe(plan.skill)
        if (text.routine) {
          expect(charLength(text.routine.name)).toBeGreaterThanOrEqual(1)
          expect(charLength(text.routine.name)).toBeLessThanOrEqual(ROUTINE_NAME_MAX)
          expect(text.routine.prompt.length).toBeGreaterThan(0)
          expect(text.routine.prompt.length).toBeLessThanOrEqual(ROUTINE_PROMPT_MAX)
        }
        if (text.skill) {
          // The skill passes the same checks as the skill form (spec 017).
          expect(skillProblems(text.skill)).toEqual([])
          expect(skillName(text.skill.name)).toBe(text.skill.name)
          expect(charLength(text.skill.description)).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX)
          expect(text.skill.instructions.length).toBeLessThanOrEqual(SKILL_INSTRUCTIONS_MAX)
        }
        // The app fills no placeholder in these texts.
        for (const value of [text.name, text.job, text.role, text.instructions])
          expect(placeholders(value)).toEqual([])
      })
    }
  }

  test("English and Korean each have their own text", () => {
    for (const id of STARTERS) {
      const en = starterText("en", id)
      const ko = starterText("ko", id)
      expect(HANGUL.test(en.name + en.job + en.role + en.instructions)).toBe(false)
      for (const value of [ko.name, ko.job, ko.role, ko.instructions])
        expect(HANGUL.test(value)).toBe(true)
      expect(ko.name).not.toBe(en.name)
      expect(ko.role).not.toBe(en.role)
      expect(ko.instructions).not.toBe(en.instructions)
      if (en.routine && ko.routine) {
        expect(HANGUL.test(ko.routine.name + ko.routine.prompt)).toBe(true)
        expect(ko.routine.name).not.toBe(en.routine.name)
      }
      if (en.skill && ko.skill) {
        expect(HANGUL.test(ko.skill.name + ko.skill.description + ko.skill.instructions)).toBe(true)
        expect(ko.skill.name).not.toBe(en.skill.name)
      }
    }
  })

  test("the English text uses short sentences", () => {
    for (const id of STARTERS) {
      const text = starterText("en", id)
      const all = [
        text.job,
        text.role,
        text.instructions,
        text.routine?.prompt ?? "",
        text.skill?.description ?? "",
        text.skill?.instructions ?? "",
      ]
      for (const value of all)
        for (const sentence of value.split(/[.!?\n]+/))
          expect(sentence.trim().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(25)
    }
  })

  test("only the Briefer makes a routine, and it runs on weekdays at 08:00", () => {
    expect(STARTERS.filter((id) => STARTER_PLANS[id].routine)).toEqual(["briefer"])
    expect(STARTER_ROUTINE_SCHEDULE).toEqual({
      kind: "weekly",
      days: [1, 2, 3, 4, 5],
      time: "08:00",
    })
    expect(validSchedule(STARTER_ROUTINE_SCHEDULE)).toBe(true)
  })

  test("the Assistant makes nothing else, and each other starter makes a skill", () => {
    expect(STARTER_PLANS.assistant).toEqual({ routine: false, skill: false })
    for (const id of ["briefer", "researcher", "reviewer", "organizer"] as const)
      expect(STARTER_PLANS[id].skill).toBe(true)
  })

  test("the muted line says what else the starter makes", () => {
    expect(starterExtras("en", "briefer")).toBe("A paused routine, 1 skill")
    expect(starterExtras("en", "researcher")).toBe("1 skill")
    expect(starterExtras("en", "assistant")).toBe("Makes nothing else")
    expect(starterExtras("ko", "briefer")).toBe("일시 중지된 루틴 1개, 스킬 1개")
    expect(starterExtras("ko", "assistant")).toBe("추가로 만드는 것 없음")
  })

  test("the instructions of each starter tell the agent what the spec lists", () => {
    const has = (id: (typeof STARTERS)[number], words: string[]) => {
      const text = starterText("en", id).instructions.toLowerCase()
      for (const word of words) expect(text).toContain(word)
    }
    has("assistant", ["short", "one question"])
    has("briefer", [
      "memory",
      "search the web",
      "one or two items",
      "10 lines",
      "source",
      "nothing is new",
    ])
    has("researcher", ["source", "guess", "disagree", "open"])
    has("reviewer", ["read before", "do not change a file", "place", "most risky", "no problem"])
    has("organizer", ["plan", "never delete", "review", "how many files"])
  })

  test("the role line follows the table of the spec", () => {
    const role = (id: (typeof STARTERS)[number]) => starterText("en", id).role.toLowerCase()
    expect(role("assistant")).toContain("writing")
    expect(role("briefer")).toContain("briefing")
    expect(role("researcher")).toContain("facts")
    expect(role("reviewer")).toContain("code")
    expect(role("organizer")).toContain("files")
  })

  test("the notes name the part, the limit and the reason", () => {
    const limit = translate("en", "starters.note.routine.limit", {
      name: "Weekday briefing",
      n: 50,
    })
    expect(limit).toContain("Weekday briefing")
    expect(limit).toContain("50 routines")
    expect(translate("en", "starters.note.skill.limit", { name: "x", n: 100 })).toContain(
      "100 skills",
    )
    expect(translate("ko", "starters.note.skill.limit", { name: "x", n: 100 })).toContain("100")
  })
})

describe("the request of the form", () => {
  const form = { serverId: "s", name: "Briefer", role: "", instructions: "" }
  const decode = Schema.decodeUnknownSync(AgentStarterCreate)
  /** The request is refused by the check, and not by a mistake in the test. */
  const refused = (value: unknown, reason?: string) => {
    let error: unknown
    try {
      decode(value)
    } catch (e) {
      error = e
    }
    expect((error as Error | undefined)?.name, JSON.stringify(value).slice(0, 80)).toBe(
      "SchemaError",
    )
    if (reason) expect((error as Error).message).toContain(reason)
  }
  const routine = { name: "Weekday briefing", prompt: "Write my briefing." }
  const skill = { name: "Brief me now", description: "", instructions: "Write it now." }
  const good = { routine, skill }

  test("the strings of every starter, in each language, pass the checks", () => {
    for (const locale of LOCALES)
      for (const id of STARTERS) {
        const setup = starterSetup(starterText(locale, id))
        expect(setup === null, `${id} ${locale}`).toBe(
          !STARTER_PLANS[id].routine && !STARTER_PLANS[id].skill,
        )
        if (setup) expect(decode({ ...form, starter: setup }).starter).toEqual(setup)
      }
  })

  test("the Assistant has no strings, so the window makes a plain agent", () => {
    expect(starterSetup(starterText("en", "assistant"))).toBeNull()
    expect(starterSetup(starterText("ko", "assistant"))).toBeNull()
  })

  test("a part that the starter does not make is null, and the field must be there", () => {
    expect(decode({ ...form, starter: { routine: null, skill } }).starter.routine).toBeNull()
    expect(decode({ ...form, starter: { routine, skill: null } }).starter.skill).toBeNull()
    refused({ ...form, starter: { skill } })
    refused(form)
    // The old request, with an id and a language, is no longer a request.
    refused({ ...form, starter: { id: "briefer", locale: "en" } })
  })

  test("the fields of the form keep the checks of a plain agent", () => {
    refused({ ...form, name: "", starter: good })
    refused({ ...form, name: "x".repeat(41), starter: good })
  })

  test("a wrong routine string makes no request", () => {
    const wrong = (value: Partial<typeof routine>) => ({
      ...form,
      starter: { routine: { ...routine, ...value }, skill: null },
    })
    refused(wrong({ name: "" }))
    refused(wrong({ name: "   " }))
    refused(wrong({ name: "x".repeat(ROUTINE_NAME_MAX + 1) }))
    refused(wrong({ prompt: "" }))
    refused(wrong({ prompt: " \n " }))
    refused(wrong({ prompt: "x".repeat(ROUTINE_PROMPT_MAX + 1) }))
    // The limits themselves are allowed.
    expect(() => decode(wrong({ name: "x".repeat(ROUTINE_NAME_MAX) }))).not.toThrow()
    expect(() => decode(wrong({ prompt: "x".repeat(ROUTINE_PROMPT_MAX) }))).not.toThrow()
    refused(wrong({ name: 5 as unknown as string }))
  })

  test("a wrong skill string makes no request", () => {
    const wrong = (value: Partial<typeof skill>) => ({
      ...form,
      starter: { routine: null, skill: { ...skill, ...value } },
    })
    refused(wrong({ name: "" }), "skill_name_empty")
    refused(wrong({ name: " / " }), "skill_name_empty")
    refused(wrong({ name: "x".repeat(SKILL_NAME_MAX + 1) }), "skill_name_long")
    refused(wrong({ description: "x".repeat(SKILL_DESCRIPTION_MAX + 1) }), "skill_description_long")
    refused(wrong({ instructions: "" }), "skill_empty")
    refused(wrong({ instructions: "  " }), "skill_empty")
    refused(wrong({ instructions: "x".repeat(SKILL_INSTRUCTIONS_MAX + 1) }), "skill_empty")
    // The limits themselves are allowed, and a description may be empty.
    expect(() => decode(wrong({ name: "x".repeat(SKILL_NAME_MAX) }))).not.toThrow()
    expect(() => decode(wrong({ description: "x".repeat(SKILL_DESCRIPTION_MAX) }))).not.toThrow()
    expect(() => decode(wrong({ instructions: "x".repeat(SKILL_INSTRUCTIONS_MAX) }))).not.toThrow()
    refused(wrong({ instructions: 5 as unknown as string }))
  })

  test("a request cannot set the schedule, the pause or the place of the routine", () => {
    const sly = {
      ...routine,
      enabled: true,
      schedule: { kind: "every", minutes: 1, from: 0 },
      place: { kind: "channel", channelId: "c" },
      agentId: "other",
    }
    const made = StarterSetup.pipe(Schema.decodeUnknownSync)({ routine: sly, skill: null })
    expect(made.routine).toEqual(routine)
    const skillSly = { ...skill, enabled: false, agents: null, agentIds: ["other"] }
    const madeSkill = StarterSetup.pipe(Schema.decodeUnknownSync)({
      routine: null,
      skill: skillSly,
    })
    expect(madeSkill.skill).toEqual(skill)
  })
})
