import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { charLength } from "./agents.ts"
import { placeholders, translate } from "./i18n/index.ts"
import { BLOCKED_WORD, blockedReason } from "./task.ts"
import {
  buildTlaStarter,
  defaultStarterAgent,
  starterMenuOff,
  starterWorkflowName,
  TLC_FAIL,
  TLC_PASS,
  TLC_RESULT_WORD,
  WORKFLOW_STARTERS,
} from "./workflowStarters.ts"
import { workflowStarterText } from "./workflowStarterText.ts"
import {
  graphProblem,
  NOTE_TEXT_MAX,
  NOTIFY_TITLE_MAX,
  nearestAgentStep,
  STEP_TEXT_MAX,
  WORKFLOW_NAME_MAX,
  WorkflowInput,
} from "./workflows.ts"

const LOCALES = ["en", "ko"] as const
const HANGUL = /[\u3131-\uD79D]/

const build = (locale: (typeof LOCALES)[number], name = "TLA+ check", agentId = "agent-1") =>
  buildTlaStarter({
    serverId: "server-1",
    name,
    agentId,
    text: workflowStarterText(locale, "tla"),
  })

/** Every text of the starter in a language, with the place it comes from. */
const texts = (locale: (typeof LOCALES)[number]) => {
  const text = workflowStarterText(locale, "tla")
  return {
    name: text.name,
    job: text.job,
    needs: text.needs,
    "write.name": text.write.name,
    "write.prompt": text.write.prompt,
    "run.name": text.run.name,
    "run.prompt": text.run.prompt,
    "check.name": text.check.name,
    "pass.name": text.pass.name,
    "pass.title": text.pass.title,
    "explain.name": text.explain.name,
    "explain.prompt": text.explain.prompt,
    "gap.name": text.gap.name,
    "gap.title": text.gap.title,
    note: text.note,
  }
}

describe("the graph of TLA+ check (spec 010)", () => {
  test("this version has one starter", () => {
    expect([...WORKFLOW_STARTERS]).toEqual(["tla"])
  })

  for (const locale of LOCALES) {
    describe(locale, () => {
      const flow = build(locale, "TLA+ check", "reviewer")

      test("the nodes have the kinds and names of the table, in the order of the numbers", () => {
        const text = workflowStarterText(locale, "tla")
        expect(flow.steps.map((s) => [s.kind, s.name])).toEqual([
          ["agent", text.write.name],
          ["agent", text.run.name],
          ["condition", text.check.name],
          ["notify", text.pass.name],
          ["agent", text.explain.name],
          ["notify", text.gap.name],
        ])
      })

      test("the connections are 1-2, 2-3, 3-4 yes, 3-5 no and 5-6", () => {
        const number = new Map(flow.steps.map((s, i) => [s.id, i + 1]))
        expect(
          flow.edges.map((e) => [number.get(e.from), number.get(e.to), e.branch ?? null]),
        ).toEqual([
          [1, 2, null],
          [2, 3, null],
          [3, 4, "yes"],
          [3, 5, "no"],
          [5, 6, null],
        ])
      })

      test("the trigger is manual, and every agent step names the agent and does not continue on failure", () => {
        expect(flow.trigger).toEqual({ kind: "manual" })
        const agents = flow.steps.filter((s) => s.kind === "agent")
        expect(agents.length).toBe(3)
        for (const step of agents) {
          expect(step.kind === "agent" && step.agentId).toBe("reviewer")
          expect(step.kind === "agent" && step.continueOnFailure).toBe(false)
          expect(step.kind === "agent" && step.effort).toBeUndefined()
        }
      })

      test("the condition looks for the line TLC_RESULT: PASS, in the mode contains text", () => {
        const condition = flow.steps[2]
        expect(condition?.kind).toBe("condition")
        if (condition?.kind !== "condition") return
        expect(condition.mode).toBe("contains")
        expect(condition.contains).toBe("TLC_RESULT: PASS")
        expect(condition.contains).toBe(TLC_PASS)
      })

      test("the notifications have the titles of the table's language", () => {
        const text = workflowStarterText(locale, "tla")
        const pass = flow.steps[3]
        const gap = flow.steps[5]
        expect(pass?.kind === "notify" && pass.title).toBe(text.pass.title)
        expect(gap?.kind === "notify" && gap.title).toBe(text.gap.title)
        if (locale === "en") {
          expect(text.pass.title).toBe("TLA+ check: no error found")
          expect(text.gap.title).toBe("TLA+ check: possible gap")
        }
      })

      test("one yellow note, with no connection and no node number", () => {
        expect(flow.notes?.length).toBe(1)
        const note = flow.notes?.[0]
        expect(note?.tone).toBe("yellow")
        expect(note?.text).toBe(workflowStarterText(locale, "tla").note)
        // A note is not a step: the six steps keep the numbers 1 to 6.
        expect(flow.steps.length).toBe(6)
        expect(flow.edges.every((e) => e.from !== "n1" && e.to !== "n1")).toBe(true)
      })

      test("the graph follows the rules of the graph and the schema of a request", () => {
        expect(graphProblem(flow.steps, flow.edges)).toBeNull()
        const decoded = Schema.decodeUnknownSync(WorkflowInput)(JSON.parse(JSON.stringify(flow)))
        expect(decoded.steps.length).toBe(6)
        // No two nodes share a place on the canvas.
        const places = new Set(flow.steps.map((s) => `${s.x},${s.y}`))
        expect(places.size).toBe(6)
      })

      test("node 5 reads the reply of node 2 through the condition: the nearest agent step before it is node 2", () => {
        const near = nearestAgentStep(flow.steps, flow.edges, "s5")
        expect(near?.id).toBe("s2")
      })

      test("the name that the caller gives is the name of the workflow", () => {
        expect(build(locale, "TLA+ check 2").name).toBe("TLA+ check 2")
        expect(build(locale, "x", "a").serverId).toBe("server-1")
      })
    })
  }
})

describe("the text of the starter", () => {
  for (const locale of LOCALES) {
    test(`every text is there and fits its limit (${locale})`, () => {
      const all = texts(locale)
      for (const [place, value] of Object.entries(all)) {
        expect(value.trim().length, `${locale} ${place}`).toBeGreaterThan(0)
      }
      expect(charLength(all.name)).toBeLessThanOrEqual(WORKFLOW_NAME_MAX)
      for (const key of ["write.name", "run.name", "check.name", "pass.name"] as const)
        expect(charLength(all[key]), key).toBeLessThanOrEqual(WORKFLOW_NAME_MAX)
      for (const key of ["explain.name", "gap.name"] as const)
        expect(charLength(all[key]), key).toBeLessThanOrEqual(WORKFLOW_NAME_MAX)
      for (const key of ["pass.title", "gap.title"] as const)
        expect(charLength(all[key]), key).toBeLessThanOrEqual(NOTIFY_TITLE_MAX)
      for (const key of ["write.prompt", "run.prompt", "explain.prompt"] as const)
        expect(charLength(all[key]), key).toBeLessThanOrEqual(STEP_TEXT_MAX)
      expect(charLength(all.note)).toBeLessThanOrEqual(NOTE_TEXT_MAX)
    })
  }

  test("the two languages differ in every text that the user reads, and the Korean has Hangul", () => {
    const en = texts("en")
    const ko = texts("ko")
    for (const place of Object.keys(en) as (keyof typeof en)[]) {
      expect(ko[place], place).not.toBe(en[place])
      expect(HANGUL.test(ko[place]), `ko ${place}`).toBe(true)
    }
    expect(HANGUL.test(Object.values(en).join(" "))).toBe(false)
  })

  test("the lines TLC_RESULT: and Blocked: are the same in both languages", () => {
    for (const locale of LOCALES) {
      const all = texts(locale)
      // Node 2 writes the result line, and says the two values.
      expect(all["run.prompt"]).toContain(TLC_PASS)
      expect(all["run.prompt"]).toContain(TLC_FAIL)
      expect(all["run.prompt"]).toContain(TLC_RESULT_WORD)
      // Each agent step tells the agent to end with a last line "Blocked:".
      for (const key of ["write.prompt", "run.prompt", "explain.prompt"] as const)
        expect(all[key], `${locale} ${key}`).toContain(`"${BLOCKED_WORD}"`)
    }
    expect(TLC_PASS).toBe("TLC_RESULT: PASS")
    expect(TLC_FAIL).toBe("TLC_RESULT: FAIL")
    // The app reads the line "Blocked:" the way the spec says (005): any letter case, last line.
    expect(blockedReason("I looked.\nBlocked: Java is missing")).toBe("Java is missing")
  })

  test("the prompts name the tools and the numbers of the spec", () => {
    for (const locale of LOCALES) {
      const all = texts(locale)
      expect(all["write.prompt"]).toContain("ask_user")
      expect(all["run.prompt"]).toContain("run_command")
      expect(all["run.prompt"]).toContain("tla2tools.jar")
      expect(all["run.prompt"]).toContain("Java 17")
      expect(all["run.prompt"]).toContain("30")
      expect(all["explain.prompt"]).toContain("12")
      // Node 2 gets the reply of node 1, and node 5 gets the reply of node 2.
      expect(all["run.prompt"]).toContain("{{input}}")
      expect(all["explain.prompt"]).toContain("{{input}}")
      expect(all["write.prompt"]).not.toContain("{{input}}")
    }
  })

  test("the note and the needs line name Java, the program and the folder; the English note says that nothing is downloaded", () => {
    for (const locale of LOCALES) {
      const all = texts(locale)
      for (const key of ["note", "needs"] as const) {
        expect(all[key], `${locale} ${key}`).toContain("Java 17")
        expect(all[key], `${locale} ${key}`).toContain("tla2tools.jar")
        expect(all[key], `${locale} ${key}`).toContain("tools")
      }
    }
    expect(texts("en").note).toContain("downloads nothing")
    expect(texts("en").note).toContain("only that the model has no error")
  })

  test("no text says that a spec is proven, verified or correct", () => {
    const english = /proven|prove|proof|verif|correct/i
    const korean = /증명|검증|정확|올바/
    for (const [place, value] of Object.entries(texts("en")))
      expect(english.test(value), `en ${place}`).toBe(false)
    for (const [place, value] of Object.entries(texts("ko")))
      expect(korean.test(value), `ko ${place}`).toBe(false)
  })

  test("a Korean text has no particle pair left open, and its placeholders match the English", () => {
    for (const [place, value] of Object.entries(texts("ko"))) {
      expect(value, place).not.toMatch(/\(으\)로|을\(를\)|이\(가\)|은\(는\)/)
    }
    for (const part of [
      "write.prompt",
      "run.prompt",
      "explain.prompt",
      "note",
      "job",
      "needs",
    ] as const) {
      const key = `workflowStarter.tla.${part}` as const
      const template = (locale: "en" | "ko") => translate(locale, key)
      expect(placeholders(template("ko")), part).toEqual(placeholders(template("en")))
    }
  })
})

describe("the name of the new workflow", () => {
  test("a free name stays as it is", () => {
    expect(starterWorkflowName("TLA+ check", [])).toBe("TLA+ check")
    expect(starterWorkflowName("TLA+ check", ["Digest"])).toBe("TLA+ check")
  })

  test("a taken name gets a number, ignoring case, as for an import", () => {
    expect(starterWorkflowName("TLA+ check", ["TLA+ check"])).toBe("TLA+ check 2")
    expect(starterWorkflowName("TLA+ check", ["tla+ CHECK", "TLA+ check 2"])).toBe("TLA+ check 3")
    expect(starterWorkflowName("TLA+ check", ["  TLA+ check  "])).toBe("TLA+ check 2")
  })

  test("the number fits inside the length limit", () => {
    const long = "T".repeat(WORKFLOW_NAME_MAX)
    const made = starterWorkflowName(long, [long])
    expect(charLength(made)).toBeLessThanOrEqual(WORKFLOW_NAME_MAX)
    expect(made.endsWith(" 2")).toBe(true)
  })
})

describe("the field Agent", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }]

  test("the default is the main agent, or else the first agent of the list", () => {
    expect(defaultStarterAgent(list, "b")).toBe("b")
    expect(defaultStarterAgent(list, null)).toBe("a")
    expect(defaultStarterAgent(list)).toBe("a")
    // A main agent that is not in the list (archived, or on another server) does not count.
    expect(defaultStarterAgent(list, "gone")).toBe("a")
  })

  test("an empty list gives no agent", () => {
    expect(defaultStarterAgent([])).toBe("")
    expect(defaultStarterAgent([], "b")).toBe("")
  })
})

describe("when the menu choice is off", () => {
  test("it is on with an agent, and off with none", () => {
    expect(starterMenuOff({ canChange: true, agentCount: 1 })).toBeNull()
    expect(starterMenuOff({ canChange: true, agentCount: 0 })).toBe("no_agent")
  })

  test("a linked computer without the switch gets the reason about the switch", () => {
    expect(starterMenuOff({ canChange: false, agentCount: 3 })).toBe("no_switch")
    expect(starterMenuOff({ canChange: false, agentCount: 0 })).toBe("no_switch")
  })
})
