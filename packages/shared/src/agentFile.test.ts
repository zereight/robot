import { describe, expect, test } from "bun:test"
import {
  AGENT_FILE_FORMAT,
  AGENT_FILE_MAX_AGENTS,
  AGENT_FILE_VERSION,
  type AgentFileAgent,
  type AgentFileRoutine,
  numberedName,
  parseAgentFile,
  planNames,
  writeAgentFile,
} from "./agentFile.ts"
import { AGENT_NAME_MAX, charLength, nameKey } from "./agents.ts"

const agent = (over: Record<string, unknown> = {}) => ({
  name: "Ada",
  role: "Researcher",
  instructions: "Be brief.",
  face: { shape: 2, hue: 7 },
  routines: [],
  ...over,
})

const file = (agents: unknown, over: Record<string, unknown> = {}) =>
  JSON.stringify({ format: AGENT_FILE_FORMAT, version: AGENT_FILE_VERSION, agents, ...over })

const refused = (text: string) => {
  const result = parseAgentFile(text)
  if (result.ok) throw new Error("the file was accepted")
  return result
}

describe("parseAgentFile", () => {
  test("reads name, role line, instructions, face and routines", () => {
    const routine: AgentFileRoutine = {
      name: "Digest",
      prompt: "Summarise the news.",
      schedule: { kind: "daily", times: ["08:30"] },
    }
    const result = parseAgentFile(file([agent({ routines: [routine] })]))
    expect(result).toEqual({
      ok: true,
      file: {
        agents: [
          {
            name: "Ada",
            role: "Researcher",
            instructions: "Be brief.",
            face: { shape: 2, hue: 7 },
            routines: [routine],
          },
        ],
      },
    })
  })

  test("a file that was written reads back the same", () => {
    const agents: AgentFileAgent[] = [
      {
        name: "Bob",
        role: "",
        instructions: "Line one\nLine two",
        face: { shape: 0, hue: 9 },
        routines: [
          { name: "Once", prompt: "Go", schedule: { kind: "once", at: 1_800_000_000_000 } },
          { name: "Often", prompt: "Go", schedule: { kind: "every", minutes: 90, from: 0 } },
          {
            name: "Weekly",
            prompt: "Go",
            schedule: { kind: "weekly", days: [1, 3], time: "9:05" },
          },
          { name: "Cron", prompt: "Go", schedule: { kind: "cron", expr: "*/5 * * * *" } },
        ],
      },
    ]
    const text = writeAgentFile(agents)
    expect(JSON.parse(text)).toMatchObject({ format: "robot-agents", version: 1 })
    expect(parseAgentFile(text)).toEqual({ ok: true, file: { agents } })
  })

  test("only the name is required; the other fields get defaults", () => {
    const result = parseAgentFile(file([{ name: "  Ada  " }]))
    expect(result).toEqual({
      ok: true,
      file: {
        agents: [{ name: "Ada", role: "", instructions: "", face: null, routines: [] }],
      },
    })
  })

  test("fields that the format does not define are ignored", () => {
    const result = parseAgentFile(
      file([
        agent({
          model: { accountId: "a", model: "m", effort: null },
          workspace: "/etc",
          permission: "full",
          apiKey: "x",
          memory: ["secret fact"],
          history: [{ text: "hi" }],
        }),
      ]),
    )
    if (!result.ok) throw new Error("refused")
    expect(Object.keys(result.file.agents[0] ?? {}).sort()).toEqual([
      "face",
      "instructions",
      "name",
      "role",
      "routines",
    ])
  })

  test("a byte order mark at the start is allowed", () => {
    expect(parseAgentFile(`\uFEFF${file([agent()])}`).ok).toBe(true)
  })

  test("a file that is not an agent file is refused", () => {
    expect(refused("not json").code).toBe("agent_file_format")
    expect(refused("[]").code).toBe("agent_file_format")
    expect(refused(file([agent()], { format: "other" })).code).toBe("agent_file_format")
  })

  test("a newer format version is refused; a version that is not a number is not valid", () => {
    expect(refused(file([agent()], { version: 2 }))).toEqual({
      ok: false,
      code: "agent_file_version",
      detail: "2",
    })
    expect(refused(file([agent()], { version: "1" }))).toEqual({
      ok: false,
      code: "agent_file_field",
      detail: "version",
    })
    expect(refused(file([agent()], { version: 0 })).code).toBe("agent_file_field")
  })

  test("a file holds 1 to 40 agents", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => agent({ name: `Agent ${i}` }))
    expect(parseAgentFile(file(many(AGENT_FILE_MAX_AGENTS))).ok).toBe(true)
    expect(refused(file(many(AGENT_FILE_MAX_AGENTS + 1)))).toEqual({
      ok: false,
      code: "agent_file_too_many",
      detail: "41",
    })
    expect(refused(file([])).code).toBe("agent_file_empty")
    expect(refused(file("x")).code).toBe("agent_file_field")
  })

  test("two agents with one name are refused, ignoring case and spaces", () => {
    expect(refused(file([agent({ name: "Ada" }), agent({ name: " ada " })]))).toEqual({
      ok: false,
      code: "agent_file_duplicate",
      detail: "ada",
    })
  })

  test("a name has 1 to 40 characters and a role line has up to 120", () => {
    expect(parseAgentFile(file([agent({ name: "가".repeat(40) })])).ok).toBe(true)
    expect(refused(file([agent({ name: "가".repeat(41) })]))).toEqual({
      ok: false,
      code: "agent_file_name_length",
      detail: "agents[0].name",
    })
    expect(refused(file([agent({ name: "   " })])).code).toBe("agent_file_name_length")
    expect(refused(file([agent({ name: 5 })])).code).toBe("agent_file_field")
    expect(parseAgentFile(file([agent({ role: "x".repeat(120) })])).ok).toBe(true)
    expect(refused(file([agent({ role: "x".repeat(121) })]))).toEqual({
      ok: false,
      code: "agent_file_role_length",
      detail: "agents[0].role",
    })
  })

  test("a face needs a shape from 0 to 5 and a hue from 0 to 9", () => {
    expect(parseAgentFile(file([agent({ face: { shape: 5, hue: 9 } })])).ok).toBe(true)
    expect(refused(file([agent({ face: { shape: 6, hue: 0 } })])).detail).toBe("agents[0].face")
    expect(refused(file([agent({ face: { shape: 0, hue: 10 } })])).code).toBe("agent_file_field")
    expect(refused(file([agent({ face: { shape: 0.5, hue: 1 } })])).code).toBe("agent_file_field")
  })

  test("a routine needs a name, a prompt and a valid schedule; the error names the place", () => {
    const routine = (over: Record<string, unknown>) =>
      file([
        agent({
          routines: [
            { name: "R", prompt: "P", schedule: { kind: "cron", expr: "* * * * *" }, ...over },
          ],
        }),
      ])
    expect(parseAgentFile(routine({})).ok).toBe(true)
    expect(refused(routine({ name: "" })).detail).toBe("agents[0].routines[0].name")
    expect(refused(routine({ name: "x".repeat(61) })).code).toBe("agent_file_field")
    expect(refused(routine({ prompt: "" })).detail).toBe("agents[0].routines[0].prompt")
    expect(refused(routine({ schedule: { kind: "cron", expr: "nope" } }))).toEqual({
      ok: false,
      code: "agent_file_schedule",
      detail: "agents[0].routines[0].schedule",
    })
    expect(refused(routine({ schedule: { kind: "daily", times: ["25:00"] } })).code).toBe(
      "agent_file_schedule",
    )
    expect(refused(routine({ schedule: { kind: "every", minutes: 0, from: 0 } })).code).toBe(
      "agent_file_schedule",
    )
    expect(refused(routine({ schedule: { kind: "weekly", days: [7], time: "09:00" } })).code).toBe(
      "agent_file_schedule",
    )
    expect(refused(routine({ schedule: { kind: "never" } })).code).toBe("agent_file_schedule")
  })
})

describe("numberedName", () => {
  const taking = (...names: string[]) => {
    const used = new Set(names.map(nameKey))
    return (candidate: string) => used.has(nameKey(candidate))
  }

  test("a free name stays as it is", () => {
    expect(numberedName("Ada", taking("Bob"))).toBe("Ada")
  })

  test("a taken name gets a number, ignoring case", () => {
    expect(numberedName("Ada", taking("ADA"))).toBe("Ada 2")
    expect(numberedName("Ada", taking("ada", "Ada 2", "ADA 3"))).toBe("Ada 4")
  })

  test("the number fits inside the name limit", () => {
    const long = "x".repeat(AGENT_NAME_MAX)
    const result = numberedName(long, taking(long))
    expect(charLength(result)).toBe(AGENT_NAME_MAX)
    expect(result).toBe(`${"x".repeat(AGENT_NAME_MAX - 2)} 2`)
    const korean = "가".repeat(AGENT_NAME_MAX)
    expect(charLength(numberedName(korean, taking(korean)))).toBe(AGENT_NAME_MAX)
  })
})

describe("planNames", () => {
  test("numbers names that the server has and names that an earlier agent of the file got", () => {
    expect(planNames(["Ada", "Bob", "ada"], ["ADA"])).toEqual(["Ada 2", "Bob", "ada 3"])
  })

  test("keeps the order and does not change free names", () => {
    expect(planNames(["B", "A"], [])).toEqual(["B", "A"])
  })
})
