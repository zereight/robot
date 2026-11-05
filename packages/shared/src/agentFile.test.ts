import { describe, expect, test } from "bun:test"
import {
  AGENT_FILE_FORMAT,
  AGENT_FILE_MAX_AGENTS,
  AGENT_FILE_MAX_CHANNELS,
  AGENT_FILE_MAX_SKILLS,
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
        version: 2,
        agents: [
          {
            name: "Ada",
            role: "Researcher",
            instructions: "Be brief.",
            face: { shape: 2, hue: 7 },
            routines: [routine],
          },
        ],
        channels: [],
        skills: [],
        handbook: "",
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
    expect(JSON.parse(text)).toMatchObject({ format: "robot-agents", version: 2 })
    expect(parseAgentFile(text)).toEqual({
      ok: true,
      file: { version: 2, agents, channels: [], skills: [], handbook: "" },
    })
  })

  test("only the name is required; the other fields get defaults", () => {
    const result = parseAgentFile(file([{ name: "  Ada  " }]))
    expect(result).toEqual({
      ok: true,
      file: {
        version: 2,
        agents: [{ name: "Ada", role: "", instructions: "", face: null, routines: [] }],
        channels: [],
        skills: [],
        handbook: "",
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
    expect(refused(file([agent()], { version: 3 }))).toEqual({
      ok: false,
      code: "agent_file_version",
      detail: "3",
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

const channel = (over: Record<string, unknown> = {}) => ({
  name: "Launch",
  topic: "Ship it",
  instructions: "Be brief.",
  reviewParts: true,
  members: ["Ada", "bob"],
  lead: "Ada",
  ...over,
})

const skill = (over: Record<string, unknown> = {}) => ({
  name: "Summarise",
  description: "Short summary",
  instructions: "Summarise the text.",
  agents: ["Ada"],
  ...over,
})

const two = [agent({ name: "Ada" }), agent({ name: "Bob" })]

describe("parseAgentFile, version 2: channels, skills and the handbook", () => {
  test("reads a channel by the names of its agents, ignoring case", () => {
    const result = parseAgentFile(file(two, { channels: [channel()] }))
    if (!result.ok) throw new Error(`refused: ${result.code} ${result.detail}`)
    expect(result.file.channels).toEqual([
      {
        name: "Launch",
        topic: "Ship it",
        instructions: "Be brief.",
        reviewParts: true,
        members: [0, 1],
        lead: 0,
        parent: null,
      },
    ])
  })

  test("a channel needs a name; the other fields get defaults", () => {
    const result = parseAgentFile(file(two, { channels: [{ name: "  Plain ", members: ["Bob"] }] }))
    if (!result.ok) throw new Error("refused")
    expect(result.file.channels).toEqual([
      {
        name: "Plain",
        topic: "",
        instructions: "",
        reviewParts: false,
        members: [1],
        lead: null,
        parent: null,
      },
    ])
  })

  test("the limits of a channel are the limits of the app", () => {
    const channels = (over: Record<string, unknown>) => file(two, { channels: [channel(over)] })
    expect(parseAgentFile(channels({ name: "x".repeat(60) })).ok).toBe(true)
    expect(refused(channels({ name: "x".repeat(61) })).detail).toBe("channels[0].name")
    expect(refused(channels({ name: " " })).detail).toBe("channels[0].name")
    expect(parseAgentFile(channels({ topic: "x".repeat(200) })).ok).toBe(true)
    expect(refused(channels({ topic: "x".repeat(201) })).detail).toBe("channels[0].topic")
    expect(parseAgentFile(channels({ instructions: "x".repeat(4000) })).ok).toBe(true)
    expect(refused(channels({ instructions: "x".repeat(4001) })).detail).toBe(
      "channels[0].instructions",
    )
    expect(refused(channels({ reviewParts: "yes" })).detail).toBe("channels[0].reviewParts")
    expect(refused(channels({ parent: "" })).detail).toBe("channels[0].parent")
    expect(refused(channels({ parent: 3 })).detail).toBe("channels[0].parent")
  })

  test("the parent is another channel of the file, or none", () => {
    const text = file(two, {
      channels: [channel({ name: "Product" }), channel({ name: "Docs", parent: " product " })],
    })
    const result = parseAgentFile(text)
    if (!result.ok) throw new Error("refused")
    expect(result.file.channels.map((c) => [c.name, c.parent])).toEqual([
      ["Product", null],
      ["Docs", "product"],
    ])
    expect(refused(file(two, { channels: [channel({ parent: "Missing" })] })).detail).toBe(
      "channels[0].parent",
    )
    expect(refused(file(two, { channels: [channel({ parent: "Launch" })] })).detail).toBe(
      "channels[0].parent",
    )
  })

  test("a member or a lead must be an agent of the file; the lead must be a member", () => {
    const channels = (over: Record<string, unknown>) => file(two, { channels: [channel(over)] })
    expect(refused(channels({ members: ["Ada", "Zed"] }))).toEqual({
      ok: false,
      code: "agent_file_member",
      detail: "channels[0].members[1]",
    })
    expect(refused(channels({ members: [] })).detail).toBe("channels[0].members")
    expect(refused(channels({ members: ["Ada", 7] })).detail).toBe("channels[0].members[1]")
    expect(refused(channels({ lead: "Zed" })).code).toBe("agent_file_member")
    expect(refused(channels({ members: ["Ada"], lead: "Bob" }))).toEqual({
      ok: false,
      code: "agent_file_field",
      detail: "channels[0].lead",
    })
    expect(parseAgentFile(channels({ lead: null })).ok).toBe(true)
  })

  test("a member that is listed twice counts once", () => {
    const result = parseAgentFile(
      file(two, { channels: [channel({ members: ["Ada", "ada", "Bob"], lead: null })] }),
    )
    if (!result.ok) throw new Error("refused")
    expect(result.file.channels[0]?.members).toEqual([0, 1])
  })

  test("two channels, or two skills, with one name are refused", () => {
    expect(refused(file(two, { channels: [channel(), channel({ name: " LAUNCH " })] }))).toEqual({
      ok: false,
      code: "agent_file_duplicate_channel",
      detail: "LAUNCH",
    })
    expect(refused(file(two, { skills: [skill(), skill({ name: "/summarise" })] }))).toEqual({
      ok: false,
      code: "agent_file_duplicate_skill",
      detail: "summarise",
    })
  })

  test("reads a skill with the agents of the file that may use it", () => {
    const result = parseAgentFile(
      file(two, { skills: [skill({ name: "/Summarise ", agents: ["bob", "Ada"] })] }),
    )
    if (!result.ok) throw new Error("refused")
    expect(result.file.skills).toEqual([
      {
        name: "Summarise",
        description: "Short summary",
        instructions: "Summarise the text.",
        agents: [1, 0],
      },
    ])
  })

  test("the limits of a skill are the limits of the skill form", () => {
    const skills = (over: Record<string, unknown>) => file(two, { skills: [skill(over)] })
    expect(refused(skills({ name: "x".repeat(41) })).detail).toBe("skills[0].name")
    expect(refused(skills({ description: "x".repeat(141) })).detail).toBe("skills[0].description")
    expect(refused(skills({ instructions: "  " })).detail).toBe("skills[0].instructions")
    expect(refused(skills({ instructions: "x".repeat(20_001) })).detail).toBe(
      "skills[0].instructions",
    )
    expect(refused(skills({ instructions: 5 })).code).toBe("agent_file_field")
    expect(refused(skills({ agents: [] })).detail).toBe("skills[0].agents")
    expect(refused(skills({ agents: ["Zed"] }))).toEqual({
      ok: false,
      code: "agent_file_member",
      detail: "skills[0].agents[0]",
    })
    expect(parseAgentFile(file(two, { skills: [{ ...skill(), description: undefined }] })).ok).toBe(
      true,
    )
  })

  test("a file holds at most 40 channels and 100 skills", () => {
    const channels = (n: number) =>
      Array.from({ length: n }, (_, i) => channel({ name: `Channel ${i}`, lead: null }))
    const skills = (n: number) => Array.from({ length: n }, (_, i) => skill({ name: `Skill ${i}` }))
    expect(parseAgentFile(file(two, { channels: channels(AGENT_FILE_MAX_CHANNELS) })).ok).toBe(true)
    expect(refused(file(two, { channels: channels(AGENT_FILE_MAX_CHANNELS + 1) }))).toEqual({
      ok: false,
      code: "agent_file_too_many_channels",
      detail: "41",
    })
    expect(parseAgentFile(file(two, { skills: skills(AGENT_FILE_MAX_SKILLS) })).ok).toBe(true)
    expect(refused(file(two, { skills: skills(AGENT_FILE_MAX_SKILLS + 1) }))).toEqual({
      ok: false,
      code: "agent_file_too_many_skills",
      detail: "101",
    })
    expect(refused(file(two, { channels: "x" })).detail).toBe("channels")
    expect(refused(file(two, { skills: {} })).detail).toBe("skills")
  })

  test("reads the handbook; it holds up to 20000 characters", () => {
    const result = parseAgentFile(file(two, { handbook: "Answer in Korean." }))
    if (!result.ok) throw new Error("refused")
    expect(result.file.handbook).toBe("Answer in Korean.")
    expect(parseAgentFile(file(two, { handbook: "x".repeat(20_000) })).ok).toBe(true)
    expect(refused(file(two, { handbook: "x".repeat(20_001) })).detail).toBe("handbook")
    expect(refused(file(two, { handbook: 5 })).detail).toBe("handbook")
    const none = parseAgentFile(file(two, { handbook: null }))
    expect(none.ok && none.file.handbook).toBe("")
  })

  test("a file of version 1 is still read; its channels, skills and handbook are not defined", () => {
    const result = parseAgentFile(
      file(two, { version: 1, channels: [channel()], skills: [skill()], handbook: "Text" }),
    )
    if (!result.ok) throw new Error("refused")
    expect(result.file.version).toBe(1)
    expect(result.file.agents).toHaveLength(2)
    expect(result.file.channels).toEqual([])
    expect(result.file.skills).toEqual([])
    expect(result.file.handbook).toBe("")
  })

  test("a file that was written reads back the same", () => {
    const agents: AgentFileAgent[] = ["Ada", "Bob"].map((name) => ({
      name,
      role: "",
      instructions: "",
      face: null,
      routines: [],
    }))
    const text = writeAgentFile(agents, {
      channels: [
        {
          name: "Launch",
          topic: "",
          instructions: "Be brief.",
          reviewParts: false,
          members: ["Ada", "Bob"],
          lead: "Bob",
        },
      ],
      skills: [{ name: "Summarise", description: "", instructions: "Do it.", agents: ["Bob"] }],
      handbook: "Answer in Korean.",
    })
    const result = parseAgentFile(text)
    if (!result.ok) throw new Error("refused")
    expect(result.file.channels[0]).toMatchObject({ members: [0, 1], lead: 1, reviewParts: false })
    expect(result.file.skills[0]).toMatchObject({ name: "Summarise", agents: [1] })
    expect(result.file.handbook).toBe("Answer in Korean.")
  })

  test("a part that is not asked for is not written", () => {
    const text = writeAgentFile([
      { name: "Ada", role: "", instructions: "", face: null, routines: [] },
    ])
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["agents", "format", "version"])
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
