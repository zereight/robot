import {
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  charLength,
  FACE_HUES,
  FACE_SHAPES,
  type Face,
  nameKey,
} from "./agents.ts"
import { CHANNEL_NAME_MAX, CHANNEL_TOPIC_MAX } from "./channels.ts"
import { CHANNEL_INSTRUCTIONS_MAX, HANDBOOK_MAX } from "./handbook.ts"
import type { NotImported } from "./importReview.ts"
import { ROUTINE_NAME_MAX, ROUTINE_PROMPT_MAX } from "./routines.ts"
import { type Schedule, validSchedule } from "./schedule.ts"
import { SKILLS_MAX, skillName, skillNameKey, skillProblems } from "./skills.ts"

/** The value of the `format` field. It tells an agent file from other JSON files. */
export const AGENT_FILE_FORMAT = "robot-agents"
/** The format version that this app writes. It reads this version and version 1. */
export const AGENT_FILE_VERSION = 2
export const AGENT_FILE_MAX_AGENTS = 40
/** A file holds at most this many channels (version 2). */
export const AGENT_FILE_MAX_CHANNELS = 40
/** A file holds at most this many skills (version 2): the limit of skills of a server. */
export const AGENT_FILE_MAX_SKILLS = SKILLS_MAX
export const AGENT_FILE_MAX_BYTES = 10 * 1024 * 1024

export interface AgentFileRoutine {
  readonly name: string
  readonly prompt: string
  readonly schedule: Schedule
}

export interface AgentFileAgent {
  readonly name: string
  readonly role: string
  readonly instructions: string
  /** Null when the file gives no face. The importing app then draws one from the name. */
  readonly face: Face | null
  readonly routines: readonly AgentFileRoutine[]
}

/**
 * A channel of a version 2 file, as it is read. The members and the lead are the places of agents
 * in the `agents` list of the file (the file gives their names).
 */
export interface AgentFileChannel {
  readonly name: string
  readonly topic: string
  readonly instructions: string
  /** "Review parts" of the channel (spec 004). */
  readonly reviewParts: boolean
  /** Places in the `agents` list, in the order of the file. At least one. */
  readonly members: readonly number[]
  /** A place in the `agents` list. One of the members, or null. */
  readonly lead: number | null
  /**
   * The name of the parent channel in this file, or null for a top channel (spec 002, 030).
   * The name is as the file writes it, after the spaces at both ends are removed.
   */
  readonly parent: string | null
}

/** A skill of a version 2 file, as it is read. `agents` are places in the `agents` list. */
export interface AgentFileSkill {
  readonly name: string
  readonly description: string
  readonly instructions: string
  /** The agents of the file that may use the skill. At least one. */
  readonly agents: readonly number[]
}

export interface AgentFile {
  /** The format version of the file: 1 or 2. */
  readonly version: number
  readonly agents: readonly AgentFileAgent[]
  /** Always empty for version 1. */
  readonly channels: readonly AgentFileChannel[]
  /** Always empty for version 1. */
  readonly skills: readonly AgentFileSkill[]
  /** The handbook. "" when the file holds none, and always for version 1. */
  readonly handbook: string
}

/** Why a file is refused. `detail` is a path in the file, a name, or a number: never prose. */
export type AgentFileErrorCode =
  | "agent_file_format"
  | "agent_file_version"
  | "agent_file_too_large"
  | "agent_file_too_many"
  | "agent_file_empty"
  | "agent_file_duplicate"
  | "agent_file_too_many_channels"
  | "agent_file_too_many_skills"
  | "agent_file_duplicate_channel"
  | "agent_file_duplicate_skill"
  | "agent_file_member"
  | "agent_file_field"
  | "agent_file_name_length"
  | "agent_file_role_length"
  | "agent_file_schedule"

export type AgentFileParse =
  | { readonly ok: true; readonly file: AgentFile }
  | { readonly ok: false; readonly code: AgentFileErrorCode; readonly detail?: string }

type Failure = Extract<AgentFileParse, { ok: false }>

const fail = (code: AgentFileErrorCode, detail?: string): Failure =>
  detail === undefined ? { ok: false, code } : { ok: false, code, detail }

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isInt = (value: unknown, min: number, max = Number.POSITIVE_INFINITY): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max

export const readSchedule = (value: unknown): Schedule | null => {
  if (!isObject(value)) return null
  let schedule: Schedule
  switch (value.kind) {
    case "once":
      if (typeof value.at !== "number") return null
      schedule = { kind: "once", at: value.at }
      break
    case "every":
      if (!isInt(value.minutes, 1) || typeof value.from !== "number") return null
      schedule = { kind: "every", minutes: value.minutes, from: value.from }
      break
    case "daily":
      if (!Array.isArray(value.times) || !value.times.every((t) => typeof t === "string"))
        return null
      schedule = { kind: "daily", times: value.times as string[] }
      break
    case "weekly":
      if (
        !Array.isArray(value.days) ||
        !value.days.every((d) => isInt(d, 0, 6)) ||
        typeof value.time !== "string"
      )
        return null
      schedule = { kind: "weekly", days: value.days as number[], time: value.time }
      break
    case "cron":
      if (typeof value.expr !== "string") return null
      schedule = { kind: "cron", expr: value.expr }
      break
    default:
      return null
  }
  return validSchedule(schedule) ? schedule : null
}

type Step<T> = { readonly ok: true; readonly value: T } | Failure

const readRoutine = (value: unknown, path: string): Step<AgentFileRoutine> => {
  if (!isObject(value)) return fail("agent_file_field", path)
  const { name, prompt } = value
  if (
    typeof name !== "string" ||
    charLength(name.trim()) < 1 ||
    charLength(name.trim()) > ROUTINE_NAME_MAX
  )
    return fail("agent_file_field", `${path}.name`)
  if (typeof prompt !== "string" || prompt.length < 1 || charLength(prompt) > ROUTINE_PROMPT_MAX)
    return fail("agent_file_field", `${path}.prompt`)
  const schedule = readSchedule(value.schedule)
  if (!schedule) return fail("agent_file_schedule", `${path}.schedule`)
  return { ok: true, value: { name: name.trim(), prompt, schedule } }
}

const readAgent = (value: unknown, path: string): Step<AgentFileAgent> => {
  if (!isObject(value)) return fail("agent_file_field", path)
  const { name, role, instructions, face, routines } = value
  if (typeof name !== "string") return fail("agent_file_field", `${path}.name`)
  const nameLength = charLength(name.trim())
  if (nameLength < 1 || nameLength > AGENT_NAME_MAX)
    return fail("agent_file_name_length", `${path}.name`)
  if (role !== undefined && typeof role !== "string")
    return fail("agent_file_field", `${path}.role`)
  if (typeof role === "string" && charLength(role.trim()) > AGENT_ROLE_MAX)
    return fail("agent_file_role_length", `${path}.role`)
  if (instructions !== undefined && typeof instructions !== "string")
    return fail("agent_file_field", `${path}.instructions`)
  let readFace: Face | null = null
  if (face !== undefined && face !== null) {
    if (
      !isObject(face) ||
      !isInt(face.shape, 0, FACE_SHAPES - 1) ||
      !isInt(face.hue, 0, FACE_HUES - 1)
    )
      return fail("agent_file_field", `${path}.face`)
    readFace = { shape: face.shape, hue: face.hue }
  }
  if (routines !== undefined && !Array.isArray(routines))
    return fail("agent_file_field", `${path}.routines`)
  const readRoutines: AgentFileRoutine[] = []
  for (const [j, routine] of (routines ?? []).entries()) {
    const step = readRoutine(routine, `${path}.routines[${j}]`)
    if (!step.ok) return step
    readRoutines.push(step.value)
  }
  return {
    ok: true,
    value: {
      name: name.trim(),
      role: typeof role === "string" ? role.trim() : "",
      instructions: typeof instructions === "string" ? instructions : "",
      face: readFace,
      routines: readRoutines,
    },
  }
}

/** The place in the `agents` list of the agent that a name tells, or -1. */
const placeOf = (keys: readonly string[], name: unknown): number =>
  typeof name === "string" ? keys.indexOf(nameKey(name)) : -1

/** A list of names of agents of the file, as places in the list. Repeats count once. */
const readAgentNames = (
  value: unknown,
  keys: readonly string[],
  path: string,
): Step<readonly number[]> => {
  if (!Array.isArray(value)) return fail("agent_file_field", path)
  const places: number[] = []
  for (const [k, entry] of value.entries()) {
    if (typeof entry !== "string") return fail("agent_file_field", `${path}[${k}]`)
    const place = placeOf(keys, entry)
    if (place < 0) return fail("agent_file_member", `${path}[${k}]`)
    if (!places.includes(place)) places.push(place)
  }
  if (places.length === 0) return fail("agent_file_field", path)
  return { ok: true, value: places }
}

const readChannel = (
  value: unknown,
  path: string,
  keys: readonly string[],
): Step<AgentFileChannel> => {
  if (!isObject(value)) return fail("agent_file_field", path)
  const { name, topic, instructions, reviewParts, members, lead, parent } = value
  if (
    typeof name !== "string" ||
    charLength(name.trim()) < 1 ||
    charLength(name.trim()) > CHANNEL_NAME_MAX
  )
    return fail("agent_file_field", `${path}.name`)
  if (
    topic !== undefined &&
    (typeof topic !== "string" || charLength(topic.trim()) > CHANNEL_TOPIC_MAX)
  )
    return fail("agent_file_field", `${path}.topic`)
  if (
    instructions !== undefined &&
    (typeof instructions !== "string" || charLength(instructions) > CHANNEL_INSTRUCTIONS_MAX)
  )
    return fail("agent_file_field", `${path}.instructions`)
  if (reviewParts !== undefined && typeof reviewParts !== "boolean")
    return fail("agent_file_field", `${path}.reviewParts`)
  // Absent or null: a top channel. A name must be a channel of this file (checked after the list).
  if (parent !== undefined && parent !== null && typeof parent !== "string")
    return fail("agent_file_field", `${path}.parent`)
  const parentName = typeof parent === "string" ? parent.trim() : ""
  if (
    typeof parent === "string" &&
    (parentName === "" || charLength(parentName) > CHANNEL_NAME_MAX)
  )
    return fail("agent_file_field", `${path}.parent`)
  const readMembers = readAgentNames(members, keys, `${path}.members`)
  if (!readMembers.ok) return readMembers
  let readLead: number | null = null
  if (lead !== undefined && lead !== null) {
    readLead = placeOf(keys, lead)
    if (readLead < 0) return fail("agent_file_member", `${path}.lead`)
    // The lead is one of the members (spec 004).
    if (!readMembers.value.includes(readLead)) return fail("agent_file_field", `${path}.lead`)
  }
  return {
    ok: true,
    value: {
      name: name.trim(),
      topic: typeof topic === "string" ? topic.trim() : "",
      instructions: typeof instructions === "string" ? instructions : "",
      reviewParts: reviewParts === true,
      members: readMembers.value,
      lead: readLead,
      parent: parentName === "" ? null : parentName,
    },
  }
}

const readSkill = (value: unknown, path: string, keys: readonly string[]): Step<AgentFileSkill> => {
  if (!isObject(value)) return fail("agent_file_field", path)
  const { name, description, instructions } = value
  if (typeof name !== "string") return fail("agent_file_field", `${path}.name`)
  if (description !== undefined && typeof description !== "string")
    return fail("agent_file_field", `${path}.description`)
  if (typeof instructions !== "string") return fail("agent_file_field", `${path}.instructions`)
  // The limits of the skill form (spec 017) are the limits of the file.
  const problem = skillProblems({
    name,
    description: description ?? "",
    instructions,
  })[0]
  if (problem) return fail("agent_file_field", `${path}.${problem.field}`)
  const readAgents = readAgentNames(value.agents, keys, `${path}.agents`)
  if (!readAgents.ok) return readAgents
  return {
    ok: true,
    value: {
      name: skillName(name),
      description: (description ?? "").trim(),
      instructions,
      agents: readAgents.value,
    },
  }
}

/** Reads a list of a file that is absent or an array, with a limit on its length. */
const readList = <T>(
  root: Json,
  field: "channels" | "skills",
  limit: number,
  tooMany: AgentFileErrorCode,
  readOne: (value: unknown, path: string) => Step<T>,
): Step<T[]> => {
  const list = root[field]
  if (list === undefined) return { ok: true, value: [] }
  if (!Array.isArray(list)) return fail("agent_file_field", field)
  if (list.length > limit) return fail(tooMany, String(list.length))
  const out: T[] = []
  for (const [i, entry] of list.entries()) {
    const step = readOne(entry, `${field}[${i}]`)
    if (!step.ok) return step
    out.push(step.value)
  }
  return { ok: true, value: out }
}

/**
 * Reads the text of an agent file, version 1 or 2. Fields that the format does not define are
 * ignored, so a file can never carry a model, a folder or a permission into the app. The fields
 * `channels`, `skills` and `handbook` belong to version 2: in a file of version 1 they are not
 * defined, so they are ignored too. The size of the file is checked by the caller, before it
 * reads the file (see `AGENT_FILE_MAX_BYTES`).
 */
export const parseAgentFile = (text: string): AgentFileParse => {
  let root: unknown
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch {
    return fail("agent_file_format")
  }
  if (!isObject(root) || root.format !== AGENT_FILE_FORMAT) return fail("agent_file_format")
  if (!isInt(root.version, 1)) return fail("agent_file_field", "version")
  if (root.version > AGENT_FILE_VERSION) return fail("agent_file_version", String(root.version))
  if (!Array.isArray(root.agents)) return fail("agent_file_field", "agents")
  if (root.agents.length === 0) return fail("agent_file_empty")
  if (root.agents.length > AGENT_FILE_MAX_AGENTS)
    return fail("agent_file_too_many", String(root.agents.length))
  const agents: AgentFileAgent[] = []
  const seen = new Set<string>()
  for (const [i, entry] of root.agents.entries()) {
    const step = readAgent(entry, `agents[${i}]`)
    if (!step.ok) return step
    const key = nameKey(step.value.name)
    if (seen.has(key)) return fail("agent_file_duplicate", step.value.name)
    seen.add(key)
    agents.push(step.value)
  }
  const version = root.version
  if (version < 2)
    return { ok: true, file: { version, agents, channels: [], skills: [], handbook: "" } }

  const keys = agents.map((a) => nameKey(a.name))
  const channels = readList(
    root,
    "channels",
    AGENT_FILE_MAX_CHANNELS,
    "agent_file_too_many_channels",
    (value, path) => readChannel(value, path, keys),
  )
  if (!channels.ok) return channels
  const skills = readList(
    root,
    "skills",
    AGENT_FILE_MAX_SKILLS,
    "agent_file_too_many_skills",
    (value, path) => readSkill(value, path, keys),
  )
  if (!skills.ok) return skills
  // A file may not hold two channels, or two skills, of one name (as for agents).
  const channelKeys = new Set<string>()
  for (const channel of channels.value) {
    const key = channelNameKey(channel.name)
    if (channelKeys.has(key)) return fail("agent_file_duplicate_channel", channel.name)
    channelKeys.add(key)
  }
  // The parent is another channel of this file, or none (spec 002, 030).
  for (const [i, channel] of channels.value.entries()) {
    if (channel.parent === null) continue
    const key = channelNameKey(channel.parent)
    if (key === channelNameKey(channel.name) || !channelKeys.has(key))
      return fail("agent_file_field", `channels[${i}].parent`)
  }
  const skillKeys = new Set<string>()
  for (const skill of skills.value) {
    const key = skillNameKey(skill.name)
    if (skillKeys.has(key)) return fail("agent_file_duplicate_skill", skill.name)
    skillKeys.add(key)
  }
  const handbook = root.handbook
  if (
    handbook !== undefined &&
    handbook !== null &&
    (typeof handbook !== "string" || charLength(handbook) > HANDBOOK_MAX)
  )
    return fail("agent_file_field", "handbook")
  return {
    ok: true,
    file: {
      version,
      agents,
      channels: channels.value,
      skills: skills.value,
      handbook: typeof handbook === "string" ? handbook : "",
    },
  }
}

/** The key that makes channel names unique on a server: case does not count. */
export const channelNameKey = (name: string) => name.trim().normalize("NFC").toLocaleLowerCase()

/** A channel to write. The members and the lead are names of agents that the file holds. */
export interface AgentFileChannelOut {
  readonly name: string
  readonly topic: string
  readonly instructions: string
  readonly reviewParts: boolean
  readonly members: readonly string[]
  readonly lead: string | null
  /** The name of the parent channel in this file. Absent or null: a top channel. */
  readonly parent?: string | null
}

/** A skill to write. `agents` are names of agents that the file holds. */
export interface AgentFileSkillOut {
  readonly name: string
  readonly description: string
  readonly instructions: string
  readonly agents: readonly string[]
}

/** The parts that a file holds besides its agents. A part that is absent is not written. */
export interface AgentFileParts {
  readonly channels?: readonly AgentFileChannelOut[]
  readonly skills?: readonly AgentFileSkillOut[]
  readonly handbook?: string
}

/**
 * The text of an agent file for these agents, in format version 2. Two spaces of indent, a
 * newline at the end. `parts` adds the channels, the skills and the handbook (spec 002).
 */
export const writeAgentFile = (
  agents: readonly AgentFileAgent[],
  parts: AgentFileParts = {},
): string =>
  `${JSON.stringify(
    {
      format: AGENT_FILE_FORMAT,
      version: AGENT_FILE_VERSION,
      agents: agents.map((a) => ({
        name: a.name,
        role: a.role,
        instructions: a.instructions,
        face: a.face,
        routines: a.routines.map((r) => ({
          name: r.name,
          prompt: r.prompt,
          schedule: r.schedule,
        })),
      })),
      ...(parts.channels
        ? {
            channels: parts.channels.map((c) => ({
              name: c.name,
              topic: c.topic,
              instructions: c.instructions,
              reviewParts: c.reviewParts,
              members: c.members,
              lead: c.lead,
              ...(c.parent ? { parent: c.parent } : {}),
            })),
          }
        : {}),
      ...(parts.skills
        ? {
            skills: parts.skills.map((k) => ({
              name: k.name,
              description: k.description,
              instructions: k.instructions,
              agents: k.agents,
            })),
          }
        : {}),
      ...(parts.handbook !== undefined ? { handbook: parts.handbook } : {}),
    },
    null,
    2,
  )}\n`

/**
 * The name of an imported agent: the name itself, or "Name 2", "Name 3" and so on when it is
 * taken. The base is shortened when the result would be longer than the name limit (`max`, the
 * limit of agent names unless another one is given, as for a workflow).
 */
export const numberedName = (
  name: string,
  taken: (candidate: string) => boolean,
  max = AGENT_NAME_MAX,
): string => {
  const base = name.trim()
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const tail = ` ${n}`
    const room = max - charLength(tail)
    const candidate = [...base].slice(0, room).join("").trimEnd() + tail
    if (!taken(candidate)) return candidate
  }
}

/**
 * The names that an import gives, in file order. A name that an agent on the server has, or that
 * an earlier agent of the file got, is numbered. Names compare by `nameKey`, ignoring case.
 */
export const planNames = (
  names: readonly string[],
  existing: Iterable<string>,
  max = AGENT_NAME_MAX,
  key: (name: string) => string = nameKey,
): string[] => {
  const used = new Set<string>()
  for (const name of existing) used.add(key(name))
  return names.map((name) => {
    const planned = numberedName(name, (candidate) => used.has(key(candidate)), max)
    used.add(key(planned))
    return planned
  })
}

/** A routine of an agent in the review before an import. */
export interface AgentFilePreviewRoutine {
  readonly name: string
  readonly schedule: Schedule
  /** True when the app hid a secret in its name or prompt. It starts not ticked. */
  readonly secretRemoved: boolean
}

/** What an import will make, for the review screen (spec 014, "Review before an import"). */
export interface AgentFilePreviewItem {
  /** The name that the new agent gets. */
  readonly name: string
  /** The name in the file, when the new agent gets another one. */
  readonly fileName: string | null
  readonly role: string
  readonly face: Face
  /** True when the app hid a secret in the name or the role line. It starts not ticked. */
  readonly secretRemoved: boolean
  readonly instructions: {
    /** The length in characters. 0: the file gives no instructions. */
    readonly length: number
    /** True when the app hid a secret in them. They start not ticked. */
    readonly secretRemoved: boolean
  }
  readonly routines: readonly AgentFilePreviewRoutine[]
}

/** A channel of the file in the review (spec 014). */
export interface AgentFilePreviewChannel {
  /** The name that the new channel gets. */
  readonly name: string
  /** The name in the file, when the new channel gets another one. */
  readonly fileName: string | null
  readonly topic: string
  readonly reviewParts: boolean
  /** The agents of the file that it needs, as places in `agents`. */
  readonly members: readonly number[]
  /** A place in `agents`, or null. */
  readonly lead: number | null
  /** The length in characters of its instructions. 0: it has none. */
  readonly instructionsLength: number
  /** True when the app hid a secret in it. It starts not ticked. */
  readonly secretRemoved: boolean
}

/** A skill of the file in the review (spec 014). */
export interface AgentFilePreviewSkill {
  /** The name that the new skill gets. */
  readonly name: string
  /** The name in the file, when the new skill gets another one. */
  readonly fileName: string | null
  readonly description: string
  /** The agents of the file that may use it, as places in `agents`. */
  readonly agents: readonly number[]
  /** The length in characters of its instructions. */
  readonly instructionsLength: number
  /** True when the app hid a secret in it. It starts not ticked. */
  readonly secretRemoved: boolean
}

/** The handbook of the file in the review. The text is the one the import would save. */
export interface AgentFilePreviewHandbook {
  readonly text: string
  readonly length: number
  readonly secretRemoved: boolean
}

export interface AgentFilePreview {
  /** The format version of the file. */
  readonly version: number
  readonly agents: readonly AgentFilePreviewItem[]
  /** Empty for a file of version 1, or a file with no channel. */
  readonly channels: readonly AgentFilePreviewChannel[]
  readonly skills: readonly AgentFilePreviewSkill[]
  /** Null when the file holds no handbook. */
  readonly handbook: AgentFilePreviewHandbook | null
  /** How many more skills this server can hold (the limit is 100, spec 017). */
  readonly skillRoom: number
  /** What the file holds that the import does not make, with the reason. */
  readonly notImported: readonly NotImported[]
}

/** What an export wrote. `path` is null when the user cancelled. */
export interface AgentFileExported {
  readonly path: string | null
  /** The number of agents. */
  readonly count: number
  readonly channels: number
  readonly skills: number
  /** True when the file holds the handbook. */
  readonly handbook: boolean
}

export interface AgentFileImported {
  readonly agents: number
  readonly routines: number
  readonly channels: number
  readonly skills: number
  /** True when the handbook of the server was replaced. */
  readonly handbook: boolean
}

/** The detail of the error `agent_file_failed`, as JSON text. */
export interface AgentFileFailure {
  /** The part that could not be made: an agent (the default), a channel, a skill or the handbook. */
  readonly kind?: "agent" | "channel" | "skill" | "handbook"
  /** The name of the part that could not be made. Empty for the handbook. */
  readonly name: string
  /** How many agents were made before it. They stay. */
  readonly made: number
  /** How many channels and skills were made before it. They stay too. */
  readonly madeChannels?: number
  readonly madeSkills?: number
  readonly code: string
  readonly detail: string | null
}
