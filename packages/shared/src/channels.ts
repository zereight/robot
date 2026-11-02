import { Schema } from "effect"
import type { ChatMessage, MessagePart } from "./chat.ts"
import { cleanDoneTest } from "./check.ts"
import type { TaskState } from "./task.ts"

export const CHANNEL_NAME_MAX = 60
export const CHANNEL_TOPIC_MAX = 200
/** The plan card of a lead shows at most this many steps. */
export const PLAN_STEPS_MAX = 8
export const STEP_LABEL_MAX = 48

export interface Channel {
  readonly id: string
  readonly serverId: string
  readonly name: string
  readonly topic: string
  /** The agent that reads each job first. Always one of the members. */
  readonly leadId: string | null
  readonly memberIds: readonly string[]
  /** The user section of the Channels list that holds the channel, or null for "No section". */
  readonly sectionId: string | null
  /** "Review parts": a part of a plan that ends well waits for the user (spec 004). Off at first. */
  readonly reviewParts: boolean
  readonly unread: number
  readonly working: boolean
}

export const ChannelCreate = Schema.Struct({
  serverId: Schema.String,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CHANNEL_NAME_MAX * 2)),
  topic: Schema.String.check(Schema.isMaxLength(CHANNEL_TOPIC_MAX * 2)),
  memberIds: Schema.Array(Schema.String),
  leadId: Schema.NullOr(Schema.String),
  sectionId: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type ChannelCreate = typeof ChannelCreate.Type

export const ChannelPatch = Schema.Struct({
  name: Schema.optionalKey(ChannelCreate.fields.name),
  topic: Schema.optionalKey(ChannelCreate.fields.topic),
  memberIds: Schema.optionalKey(ChannelCreate.fields.memberIds),
  leadId: Schema.optionalKey(ChannelCreate.fields.leadId),
  sectionId: ChannelCreate.fields.sectionId,
  reviewParts: Schema.optionalKey(Schema.Boolean),
})
export type ChannelPatch = typeof ChannelPatch.Type

/** Most members that a linked device may name in one request. */
export const CLIENT_CHANNEL_MEMBERS_MAX = 50

const ClientMemberIds = Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(
  Schema.isMaxLength(CLIENT_CHANNEL_MEMBERS_MAX),
)

/** What a linked device may send to make a channel (spec 012). Any other field is refused. */
export const ClientChannelCreate = Schema.Struct({
  serverId: Schema.String.check(Schema.isMaxLength(100)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CHANNEL_NAME_MAX * 2)),
  topic: Schema.String.check(Schema.isMaxLength(CHANNEL_TOPIC_MAX * 2)),
  memberIds: ClientMemberIds,
  leadId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100))),
})
export type ClientChannelCreate = typeof ClientChannelCreate.Type

export const ClientChannelPatch = Schema.Struct({
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(CHANNEL_NAME_MAX * 2)),
  ),
  topic: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(CHANNEL_TOPIC_MAX * 2))),
  memberIds: Schema.optionalKey(ClientMemberIds),
  leadId: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(100)))),
})
export type ClientChannelPatch = typeof ClientChannelPatch.Type

export type ChannelMessageKind = "text" | "plan" | "summary"

/** A part that a plan message started. It shows as a chip under the message. */
export interface PartChip {
  readonly taskId: string
  readonly memberId: string
  readonly memberName: string
  readonly label: string
  readonly state: TaskState
  readonly replies: number
  /** The newest reply of the part, for the chip click. */
  readonly newestReplyId: string | null
}

/**
 * The state of the part that a message belongs to, on the last message of that part (spec 004).
 * The channel shows under it the bar of a part in review, and the card of a blocked or failed one.
 */
export interface PartInfo {
  readonly taskId: string
  readonly state: TaskState
  /** The reason of a blocked or failed part. */
  readonly error: { readonly code: string; readonly detail: string } | null
  /** The name of the other computer that owns the part, when it came by sync (spec 019). */
  readonly ownerName: string | null
}

export interface ChannelMessage extends Omit<ChatMessage, "agentId" | "author"> {
  readonly channelId: string
  readonly author: "user" | "agent"
  /** The agent that wrote it. Null for the user. */
  readonly agentId: string | null
  readonly kind: ChannelMessageKind
  /** The task that made this message. */
  readonly taskId: string | null
  /** True while the user has to say which member takes this job. */
  readonly awaiting: boolean
  readonly chips: readonly PartChip[]
  /** Set on the last message of a part of a plan. */
  readonly part: PartInfo | null
}

export type MemberState = "idle" | "working" | "waiting" | "offline"

export interface PlanStep {
  readonly taskId: string
  readonly label: string
  readonly state: TaskState
}

export interface MemberActivity {
  readonly agentId: string
  readonly state: MemberState
  /** The plan steps of a lead that has active work. Empty for the others. */
  readonly steps: readonly PlanStep[]
}

export interface ChannelActivity {
  readonly members: readonly MemberActivity[]
}

export const stepLabel = (label: string) =>
  [...label].length > STEP_LABEL_MAX
    ? `${[...label].slice(0, STEP_LABEL_MAX - 1).join("")}…`
    : label

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The member names that `text` mentions as `@Name`, in the order of the members. */
export const parseMentions = (text: string, names: readonly string[]): string[] => {
  const found = new Set<string>()
  let rest = text
  // Longer names first. A match is cut out, so "@Ada Lovelace" is not also read as "@Ada".
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, "iu")
    if (pattern.test(rest)) {
      found.add(name)
      rest = rest.replace(pattern, "$1 ")
    }
  }
  return names.filter((n) => found.has(n))
}

export interface PlanPart {
  readonly member: string
  readonly label: string
  readonly prompt: string
  /** What a finished part must hold: one line, up to 200 characters. Null when the lead gave none. */
  readonly doneTest: string | null
}

export interface ParsedPlan {
  readonly plan: string
  readonly parts: readonly PlanPart[]
}

/**
 * Reads the reply of a lead as a plan. A plan is one JSON object (a code fence around it is
 * fine) with a list of parts. Parts for unknown members are dropped, and at most 8 stay.
 * Returns null when the reply is an ordinary answer.
 */
export const parsePlan = (text: string, members: readonly string[]): ParsedPlan | null => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("`")) return null
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let data: unknown
  try {
    data = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
  const raw = (data as { parts?: unknown }).parts
  if (!Array.isArray(raw)) return null
  const parts: PlanPart[] = []
  for (const item of raw) {
    const { member, label, prompt, doneTest, done_test } = (item ?? {}) as Record<string, unknown>
    if (typeof member !== "string" || typeof prompt !== "string" || !prompt.trim()) continue
    const name = members.find((m) => m.toLocaleLowerCase() === member.trim().toLocaleLowerCase())
    if (!name) continue
    parts.push({
      member: name,
      label:
        (typeof label === "string" && label.trim() ? label : prompt).trim().split("\n")[0] ?? "",
      prompt: prompt.trim(),
      doneTest: cleanDoneTest(doneTest ?? done_test),
    })
    if (parts.length === PLAN_STEPS_MAX) break
  }
  if (parts.length === 0) return null
  const plan = (data as { plan?: unknown }).plan
  return { plan: typeof plan === "string" ? plan.trim() : "", parts }
}

/** The text of a plan message: the plan sentence and the numbered parts. */
export const planText = (plan: ParsedPlan) =>
  [plan.plan, plan.parts.map((p, i) => `${i + 1}. ${p.member}: ${p.label}`).join("\n")]
    .filter(Boolean)
    .join("\n\n")

export const textPart = (text: string): MessagePart => ({ kind: "text", text })
