import {
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  charLength,
  FACE_HUES,
  FACE_SHAPES,
  type Face,
  nameKey,
} from "./agents.ts"
import type { NotImported } from "./importReview.ts"
import { ROUTINE_NAME_MAX, ROUTINE_PROMPT_MAX } from "./routines.ts"
import { type Schedule, validSchedule } from "./schedule.ts"

/** The value of the `format` field. It tells an agent file from other JSON files. */
export const AGENT_FILE_FORMAT = "robot-agents"
/** The format version that this app writes and reads. */
export const AGENT_FILE_VERSION = 1
export const AGENT_FILE_MAX_AGENTS = 40
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

export interface AgentFile {
  readonly agents: readonly AgentFileAgent[]
}

/** Why a file is refused. `detail` is a path in the file, a name, or a number: never prose. */
export type AgentFileErrorCode =
  | "agent_file_format"
  | "agent_file_version"
  | "agent_file_too_large"
  | "agent_file_too_many"
  | "agent_file_empty"
  | "agent_file_duplicate"
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

/**
 * Reads the text of an agent file. Fields that the format does not define are ignored, so a
 * file can never carry a model, a folder or a permission into the app. The size of the file is
 * checked by the caller, before it reads the file (see `AGENT_FILE_MAX_BYTES`).
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
  return { ok: true, file: { agents } }
}

/** The text of an agent file for these agents. Two spaces of indent, a newline at the end. */
export const writeAgentFile = (agents: readonly AgentFileAgent[]): string =>
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
): string[] => {
  const used = new Set<string>()
  for (const name of existing) used.add(nameKey(name))
  return names.map((name) => {
    const planned = numberedName(name, (candidate) => used.has(nameKey(candidate)), max)
    used.add(nameKey(planned))
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

export interface AgentFilePreview {
  readonly agents: readonly AgentFilePreviewItem[]
  /** What the file holds that the import does not make, with the reason. */
  readonly notImported: readonly NotImported[]
}

export interface AgentFileImported {
  readonly agents: number
  readonly routines: number
}

/** The detail of the error `agent_file_failed`, as JSON text. */
export interface AgentFileFailure {
  /** The agent that could not be made. */
  readonly name: string
  /** How many agents were made before it. They stay. */
  readonly made: number
  readonly code: string
  readonly detail: string | null
}
