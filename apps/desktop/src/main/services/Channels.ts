import { randomUUID } from "node:crypto"
import {
  askAllowsAlways,
  askKind,
  askStep,
  askSummary,
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  type Channel,
  type ChannelActivity,
  type ChannelCreate,
  type ChannelMessage,
  type ChannelMessageKind,
  type ChannelPatch,
  charLength,
  holdOutside,
  MESSAGE_MAX,
  type MemberState,
  type MessagePart,
  type MessageStatus,
  mentionsUser,
  messageText,
  newTurnMark,
  type OutsideSource,
  outsideOfCall,
  type ParsedPlan,
  type PartChip,
  type PermissionLevel,
  PLAN_STEPS_MAX,
  parseMentions,
  parsePlan,
  planText,
  runningStepKind,
  stepLabel,
  type Task,
  type TaskState,
  type TurnMark,
  type TurnStarter,
  toolNameOf,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Layer, Stream } from "effect"
import type { AgentEvent } from "../providers/agent.ts"
import type { Turn } from "../providers/chat.ts"
import { ProviderFailure } from "../providers/client.ts"
import { bridgeToolName } from "../runtimes/bridge.ts"
import { Activity } from "./Activity.ts"
import { Agents } from "./Agents.ts"
import { type Actor, CurrentActor } from "./actor.ts"
import { applyEvent } from "./Chat.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Knowledge } from "./Knowledge.ts"
import { Notifier } from "./Notifier.ts"
import { Providers } from "./Providers.ts"
import { Sections } from "./Sections.ts"
import { Tasks } from "./Tasks.ts"
import { type ToolContext, Tools } from "./Tools.ts"

export interface ChannelsService {
  list(serverId: string): Effect.Effect<readonly Channel[]>
  get(id: string): Effect.Effect<Channel, AppError>
  create(input: ChannelCreate): Effect.Effect<Channel, AppError>
  update(id: string, patch: ChannelPatch): Effect.Effect<Channel, AppError>
  remove(id: string): Effect.Effect<void, AppError>
  history(channelId: string): Effect.Effect<readonly ChannelMessage[]>
  /** Posts a job. With a mention it goes to that member; else to the lead; else the user picks. */
  send(channelId: string, text: string): Effect.Effect<{ awaiting: boolean }, AppError>
  assign(channelId: string, messageId: string, agentId: string): Effect.Effect<void, AppError>
  stopAll(channelId: string): Effect.Effect<void>
  /** Puts a note in a channel, as a user message. It starts no job. */
  post(channelId: string, text: string): Effect.Effect<void, AppError>
  /** Calls `handler` for each message that the user sends to a channel. */
  onUserMessage(handler: (channelId: string, text: string) => void): void
  /**
   * A user message that came from the other computer by sync (spec 019). It starts no job here.
   * It tells the same handlers, so a workflow with a channel trigger can fire for it.
   */
  hearUserMessage(channelId: string, text: string): void
  /** A routine run: the agent answers the prompt in the channel. The task belongs to the routine. */
  runRoutine(
    channelId: string,
    agentId: string,
    prompt: string,
    routineId: string,
  ): Effect.Effect<void, AppError>
  activity(channelId: string): Effect.Effect<ChannelActivity>
  markRead(channelId: string): Effect.Effect<void>
  /** Tells the windows about a message that sync wrote, so an open channel shows it at once. */
  announce(messageId: string): void
  /** The text of the newest message of a channel, for the place list. */
  lastMessage(channelId: string): string | null
}

interface ChannelRow {
  id: string
  server_id: string
  name: string
  topic: string
  lead_agent_id: string | null
  place_section_id: string | null
}

interface MessageRow {
  id: string
  channel_id: string
  author: "user" | "agent"
  agent_id: string | null
  kind: ChannelMessageKind
  parts: string
  status: MessageStatus
  error_code: string | null
  error_detail: string | null
  error_resets_at: number | null
  task_id: string | null
  awaiting: number
  model: string | null
  created_at: number
  from_name: string | null
}

interface AgentRow {
  id: string
  name: string
  instructions: string
  archived_at: number | null
  model_account_id: string | null
  model_name: string | null
  model_effort: string | null
  workspace: string
  permission: PermissionLevel
  memory_enabled: number
}

const EMIT_EVERY_MS = 50
const SAVE_EVERY_MS = 500
const HISTORY_TURNS = 40
const RESULT_TEXT_MAX = 1200
const LAST_MESSAGE_MAX = 140

const LEAD_RULES = (members: readonly string[]) =>
  [
    "You lead a channel of agents. Read the job of the user.",
    "If you can answer it yourself, answer in plain text.",
    `If it should be split, reply with ONLY one JSON object and no other text: {"plan":"one sentence","parts":[{"member":"<name>","label":"<a few words>","prompt":"<what this member does>"}]}.`,
    `Use at most ${PLAN_STEPS_MAX} parts. Give each part to one of these members: ${members.join(", ")}.`,
  ].join("\n")

const ACTIVE = "('queued', 'running', 'waiting')"

export class Channels extends Context.Service<Channels, ChannelsService>()("robot/main/Channels") {
  static readonly layer = Layer.effect(
    Channels,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const providers = yield* Providers
      const tasks = yield* Tasks
      const tools = yield* Tools
      const knowledge = yield* Knowledge
      const notifier = yield* Notifier
      const agentActivity = yield* Activity
      const agents = yield* Agents
      const sections = yield* Sections

      // A reply that was streaming when the app closed keeps its parts and counts as stopped.
      // A part that streams from the other computer (spec 019) is not ours to end.
      db.run(
        "UPDATE channel_message SET status = 'stopped' WHERE status = 'streaming' AND origin IS NULL",
      )

      const channelRow = (id: string) =>
        db.get<ChannelRow>(
          "SELECT id, server_id, name, topic, lead_agent_id, place_section_id FROM channel WHERE id = ?",
          id,
        )
      const memberRows = (channelId: string) =>
        db.all<{ id: string; name: string }>(
          `SELECT a.id, a.name FROM channel_member m JOIN agent a ON a.id = m.agent_id
           WHERE m.channel_id = ? ORDER BY m.position`,
          channelId,
        )
      const agentRow = (id: string) =>
        db.get<AgentRow>(
          `SELECT id, name, instructions, archived_at, model_account_id, model_name, model_effort,
             workspace, permission, memory_enabled FROM agent WHERE id = ?`,
          id,
        )
      const hasActiveWork = (channelId: string) =>
        db.get(
          `SELECT 1 AS x FROM task WHERE source = 'channel' AND source_id = ? AND state IN ${ACTIVE}`,
          channelId,
        ) !== undefined

      const toChannel = (row: ChannelRow): Channel => {
        const memberIds = memberRows(row.id).map((m) => m.id)
        const unread =
          db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM channel_message m JOIN channel c ON c.id = m.channel_id
             WHERE m.channel_id = ? AND m.author = 'agent' AND m.finished_at > c.last_read_at`,
            row.id,
          )?.n ?? 0
        return {
          id: row.id,
          serverId: row.server_id,
          name: row.name,
          topic: row.topic,
          leadId:
            row.lead_agent_id && memberIds.includes(row.lead_agent_id) ? row.lead_agent_id : null,
          memberIds,
          sectionId: row.place_section_id,
          unread,
          working: hasActiveWork(row.id),
        }
      }

      const chipsFor = (row: MessageRow): PartChip[] => {
        if (row.kind !== "plan" || !row.task_id) return []
        return tasks.children(row.task_id).map((part) => {
          const replies = db.all<{ id: string }>(
            `SELECT id FROM channel_message WHERE task_id = ? AND author = 'agent'
             ORDER BY created_at, rowid`,
            part.id,
          )
          return {
            taskId: part.id,
            memberId: part.agentId,
            memberName: part.agentName,
            label: part.label,
            state: part.state,
            replies: replies.length,
            newestReplyId: replies.at(-1)?.id ?? null,
          }
        })
      }

      const toMessage = (row: MessageRow): ChannelMessage => ({
        id: row.id,
        channelId: row.channel_id,
        author: row.author,
        agentId: row.agent_id,
        kind: row.kind,
        parts: JSON.parse(row.parts) as MessagePart[],
        status: row.status,
        error: row.error_code
          ? { code: row.error_code, detail: row.error_detail ?? "", resetsAt: row.error_resets_at }
          : null,
        replyTo: null,
        model: row.model,
        createdAt: row.created_at,
        editedAt: null,
        fromDevice: row.from_name,
        taskId: row.task_id,
        awaiting: row.awaiting === 1,
        chips: chipsFor(row),
      })
      const messageRow = (id: string) =>
        db.get<MessageRow>("SELECT * FROM channel_message WHERE id = ?", id)
      const emitMessage = (id: string) => {
        const row = messageRow(id)
        if (row) bus.emit("channel.message", toMessage(row))
      }
      const placesChanged = (serverId: string) => bus.emit("places.changed", { serverId })

      const insertUserMessage = (
        channelId: string,
        text: string,
        awaiting: boolean,
        from: Actor | null = null,
      ) => {
        const id = randomUUID()
        db.run(
          `INSERT INTO channel_message (id, channel_id, author, parts, status, awaiting, created_at, finished_at, from_device, from_name)
           VALUES (?, ?, 'user', ?, 'done', ?, ?, ?, ?, ?)`,
          id,
          channelId,
          JSON.stringify([{ kind: "text", text }]),
          awaiting ? 1 : 0,
          Date.now(),
          Date.now(),
          from?.id ?? null,
          from?.name ?? null,
        )
        emitMessage(id)
        return id
      }

      /** The channel so far as turns for one agent. Others speak as "[Name]: text". */
      const channelTurns = (channelId: string, agent: AgentRow): Turn[] => {
        const names = new Map(memberRows(channelId).map((m) => [m.id, m.name]))
        const rows = db
          .all<MessageRow>(
            `SELECT * FROM channel_message WHERE channel_id = ? AND status IN ('done', 'stopped')
             ORDER BY created_at DESC, rowid DESC LIMIT ${HISTORY_TURNS}`,
            channelId,
          )
          .reverse()
        const turns: Turn[] = []
        for (const row of rows) {
          const text = messageText(toMessage(row)).trim()
          if (!text) continue
          if (row.author === "user") turns.push({ role: "user", content: text })
          else if (row.agent_id === agent.id) turns.push({ role: "assistant", content: text })
          else
            turns.push({
              role: "user",
              content: `[${names.get(row.agent_id ?? "") ?? "Agent"}]: ${text}`,
            })
        }
        return turns
      }

      const channelSystem = (channel: ChannelRow, agent: AgentRow, extra = "") =>
        [
          agent.instructions,
          `You are ${agent.name}. You work in the channel "${channel.name}" with: ${memberRows(
            channel.id,
          )
            .map((m) => m.name)
            .join(
              ", ",
            )}.${channel.topic ? ` Topic: ${channel.topic}.` : ""} Messages of others show as "[Name]: text". Write only your own reply.`,
          extra,
        ]
          .filter(Boolean)
          .join("\n\n")

      /** Streams one reply of an agent into the channel as a new message. Returns its id and text. */
      const streamReply = Effect.fn("Channels.streamReply")(function* (o: {
        channel: ChannelRow
        agent: AgentRow
        taskId: string
        kind: ChannelMessageKind
        system: string
        turns: Turn[]
        /** A reply that starts like JSON stays hidden until it ends: it can be a plan. */
        hideRaw?: boolean
        /** The agent may use tools in this reply. Plans and summaries do not. */
        tools?: boolean
        /** Who started the turn, and its outside content (spec 007). Plans and summaries need none. */
        turn?: TurnMark
      }) {
        const id = randomUUID()
        const parts: MessagePart[] = []
        const usage = { input: 0, output: 0 }
        const controller = new AbortController()
        let lastEmit = 0
        let lastSave = 0
        let hidden = false
        db.run(
          `INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, task_id, model, created_at)
           VALUES (?, ?, 'agent', ?, ?, '[]', 'streaming', ?, ?, ?)`,
          id,
          o.channel.id,
          o.agent.id,
          o.kind,
          o.taskId,
          o.agent.model_name,
          Date.now(),
        )
        tasks.setMessage(o.taskId, id)
        emitMessage(id)
        placesChanged(o.channel.server_id)

        const save = (
          status: MessageStatus,
          error?: { code: string; detail: string; resetsAt: number | null },
        ) => {
          db.run(
            `UPDATE channel_message SET parts = ?, status = ?, error_code = ?, error_detail = ?,
               error_resets_at = ?, input_tokens = ?, output_tokens = ?, finished_at = ? WHERE id = ?`,
            JSON.stringify(parts),
            status,
            error?.code ?? null,
            error?.detail ?? null,
            error?.resetsAt ?? null,
            usage.input,
            usage.output,
            status === "streaming" ? null : Date.now(),
            id,
          )
        }
        const onEvent = (event: AgentEvent) =>
          Effect.sync(() => {
            if (event.type === "usage") {
              usage.input = event.input ?? usage.input
              usage.output = event.output ?? usage.output
              return
            }
            const boundary = applyEvent(parts, event)
            agentActivity.setStep(o.agent.id, runningStepKind(parts))
            if (o.hideRaw && /^\s*[{`]/.test(messageText({ parts }))) hidden = true
            if (hidden) return
            const now = Date.now()
            if (boundary || now - lastSave >= SAVE_EVERY_MS) {
              save("streaming")
              lastSave = now
            }
            if (boundary || now - lastEmit >= EMIT_EVERY_MS) {
              // The streamed row is saved above; the event carries the live parts.
              const row = messageRow(id)
              if (row)
                bus.emit("channel.message", toMessage({ ...row, parts: JSON.stringify(parts) }))
              lastEmit = now
            }
          })

        const stream = Effect.gen(function* () {
          if (!o.agent.model_account_id || !o.agent.model_name)
            return yield* new AppError({ code: "provider_not_connected" })
          const useTools = o.tools === true
          const mark = o.turn ?? newTurnMark("user")
          const isRuntime = providers.isRuntime(o.agent.model_account_id)
          const changePart = (
            callId: string,
            change: (p: Extract<MessagePart, { kind: "tool" }>) => MessagePart,
          ) => {
            if (controller.signal.aborted) return
            const index = parts.findIndex((p) => p.kind === "tool" && p.id === callId)
            const part = parts[index]
            if (part?.kind !== "tool") return
            parts[index] = change(part)
            save("streaming")
            emitMessage(id)
          }
          const context: ToolContext = {
            agentId: o.agent.id,
            workspace: o.agent.workspace,
            permission: o.agent.permission,
            signal: controller.signal,
            onWaiting: (callId, ask) => {
              tasks.setWaiting(o.taskId, ask !== null)
              if (ask)
                notifier.attention({
                  agentId: o.agent.id,
                  serverId: o.channel.server_id,
                  channelId: o.channel.id,
                  callId,
                  kind: askKind(ask),
                  always: askAllowsAlways(ask),
                  summary: askSummary(ask),
                  step: askStep(ask, toolNameOf(parts, callId)),
                  target: { kind: "channel", id: o.channel.id, messageId: id },
                })
              else notifier.clearAttention(o.agent.id, callId)
              changePart(callId, (p) => {
                const { ask: _drop, ...rest } = p
                return ask ? { ...rest, state: "waiting", ask } : { ...rest, state: "running" }
              })
            },
            onMemory: (callId, memoryId) => changePart(callId, (p) => ({ ...p, memoryId })),
            onKnowledge: (callId, note) => changePart(callId, (p) => ({ ...p, knowledge: note })),
            knowledgeChanges: { count: 0 },
            turn: mark,
            taskId: o.taskId,
          }
          const events = yield* providers.events(
            o.agent.model_account_id,
            {
              model: o.agent.model_name,
              effort: o.agent.model_effort,
              system: useTools
                ? [
                    `${o.system}\n\nYour workspace folder is ${o.agent.workspace}. Use your tools when the job needs files, commands, pages or a decision from the user.`,
                    // An agent in a channel uses its own knowledge only.
                    knowledge.prompt(
                      o.agent.id,
                      o.turns.at(-1)?.content ?? "",
                      isRuntime ? "files" : "tools",
                    ) ?? "",
                  ]
                    .filter(Boolean)
                    .join("\n\n")
                : o.system,
              turns: o.turns,
              ...(useTools
                ? {
                    tools: tools.defs({
                      memory: o.agent.memory_enabled === 1,
                      knowledge: knowledge.enabled(o.agent.id),
                    }),
                  }
                : {}),
              signal: controller.signal,
              workspace: o.agent.workspace,
              permission: o.agent.permission,
              useTools,
            },
            {
              execute: async (call) =>
                useTools
                  ? tools.execute(context, call)
                  : { output: "Tools are not available here.", failed: true },
              approve: (request) => tools.approval(context, request),
              // An agent runtime has no browser of its own. It calls the app for it.
              ...(useTools && isRuntime
                ? {
                    bridge: tools.bridge(context, (event) => {
                      if (!controller.signal.aborted) Effect.runSync(onEvent(event))
                    }),
                  }
                : {}),
            },
          )
          // Closing the stream aborts first: the generator may wait in a tool and cannot end before.
          const closing: AsyncIterable<AgentEvent> = {
            [Symbol.asyncIterator]: () => {
              const it = events[Symbol.asyncIterator]()
              return {
                next: () => it.next(),
                return: (value?: unknown) => {
                  controller.abort()
                  return it.return?.(value) ?? Promise.resolve({ done: true, value: undefined })
                },
              }
            },
          }
          yield* Stream.fromAsyncIterable(closing, (e) => e).pipe(
            // The program also reports its own calls of these tools. The app shows its own cards.
            Stream.runForEach((event) => {
              if (isRuntime && event.type === "tool" && bridgeToolName(event.call.name) !== null)
                return Effect.void
              // A web, browser or connection step of the program itself gives outside content.
              if (isRuntime && event.type === "tool" && event.state !== "running")
                holdOutside(mark, outsideOfCall(event.call.name, event.call.input))
              return onEvent(event)
            }),
          )
        })

        // A vendor program writes the Knowledge folder itself. The folder is read again after it.
        const writesFiles =
          !!o.agent.model_account_id && providers.isRuntime(o.agent.model_account_id)
        knowledge.begin(o.agent.id)
        yield* stream.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              controller.abort()
              knowledge.end(o.agent.id, writesFiles ? "agent" : "user")
              notifier.clearAgent(o.agent.id)
              // A step that did not finish cannot keep a running mark or a question card.
              for (const [i, part] of parts.entries()) {
                if (part.kind !== "tool" || (part.state !== "running" && part.state !== "waiting"))
                  continue
                const { ask: _ask, ...rest } = part
                parts[i] = { ...rest, state: "failed" }
              }
              if (Exit.isSuccess(exit)) {
                save("done")
                const text = messageText({ parts })
                if (mentionsUser(text))
                  notifier.notify({
                    kind: "mention",
                    serverId: o.channel.server_id,
                    channelId: o.channel.id,
                    title: `${o.agent.name} · ${o.channel.name}`,
                    body: text,
                    target: { kind: "channel", id: o.channel.id, messageId: id },
                  })
              } else if (Cause.hasInterruptsOnly(exit.cause)) save("stopped")
              else {
                const failure = Cause.squash(exit.cause)
                if (failure instanceof ProviderFailure)
                  save("failed", {
                    code: failure.code,
                    detail: failure.detail ?? "",
                    resetsAt: failure.resetsAt ?? null,
                  })
                else if (failure instanceof AppError)
                  save("failed", {
                    code: failure.code,
                    detail: failure.detail ?? "",
                    resetsAt: null,
                  })
                else {
                  console.error("channel reply failed", Cause.pretty(exit.cause))
                  save("failed", { code: "unknown", detail: "", resetsAt: null })
                }
              }
              emitMessage(id)
              placesChanged(o.channel.server_id)
            }),
          ),
        )
        return { id, text: messageText({ parts }) }
      })

      const background = (effect: Effect.Effect<unknown, unknown, never>) =>
        Effect.forkDetach(Effect.exit(effect)).pipe(Effect.asVoid)

      /**
       * The newest message of another agent among the messages that a turn of `agent` reads, as
       * an outside source (spec 007): the turn reads it, so it holds outside content.
       */
      const otherVoice = (channelId: string, agent: AgentRow): OutsideSource | null => {
        const row = db.get<{ name: string }>(
          `SELECT a.name AS name FROM (
             SELECT agent_id, author, created_at, rowid AS r FROM channel_message
             WHERE channel_id = ? AND status IN ('done', 'stopped')
             ORDER BY created_at DESC, rowid DESC LIMIT ${HISTORY_TURNS}
           ) m JOIN agent a ON a.id = m.agent_id
           WHERE m.author = 'agent' AND m.agent_id != ?
           ORDER BY m.created_at DESC, m.r DESC LIMIT 1`,
          channelId,
          agent.id,
        )
        return row ? { kind: "agent", name: row.name } : null
      }

      /**
       * One agent answers in the channel: a task of its own, with the reply as its message.
       * `from` is the lead that gave the agent its part: the turn starts with a message from
       * another agent.
       */
      const memberTurn = (
        channel: ChannelRow,
        agent: AgentRow,
        task: Task,
        extraTurn: string | null,
        kind: ChannelMessageKind = "text",
        from: AgentRow | null = null,
      ) =>
        tasks.run(
          task.id,
          agent.id,
          Effect.suspend(() => {
            const turns = channelTurns(channel.id, agent)
            if (extraTurn) turns.push({ role: "user", content: extraTurn })
            const starter: TurnStarter =
              task.source === "routine" ? "routine" : from ? "agent" : "user"
            const turn = newTurnMark(
              starter,
              from ? { kind: "agent", name: from.name } : otherVoice(channel.id, agent),
            )
            return streamReply({
              channel,
              agent,
              taskId: task.id,
              kind,
              tools: true,
              turn,
              system: channelSystem(channel, agent),
              turns,
            })
          }),
        )

      const runRoutine = (channelId: string, agentId: string, prompt: string, routineId: string) =>
        Effect.gen(function* () {
          const channel = channelRow(channelId)
          const agent = agentRow(agentId)
          if (!channel || !agent || agent.archived_at !== null)
            return yield* new AppError({ code: "agent_not_found" })
          const task = yield* tasks.create({
            agentId,
            prompt,
            source: "routine",
            sourceId: routineId,
          })
          yield* background(memberTurn(channel, agent, task, prompt))
        })

      const startDirect = (
        channel: ChannelRow,
        agentId: string,
        prompt: string,
        retryOf: string | null = null,
      ) =>
        Effect.gen(function* () {
          const agent = agentRow(agentId)
          if (!agent) return
          const task = yield* tasks.create({
            agentId,
            prompt,
            source: "channel",
            sourceId: channel.id,
            retryOf,
          })
          yield* background(memberTurn(channel, agent, task, null))
        })

      /** The reply texts and end states of the parts, for the lead to sum up. */
      const partReport = (parts: readonly Task[]) =>
        parts
          .map((p) => {
            const now = tasks.children(p.parentId ?? "").find((x) => x.id === p.id) ?? p
            const reply = db.get<{ parts: string }>(
              `SELECT parts FROM channel_message WHERE task_id = ? AND author = 'agent'
               ORDER BY created_at DESC, rowid DESC LIMIT 1`,
              p.id,
            )
            const text = reply
              ? messageText({ parts: JSON.parse(reply.parts) as MessagePart[] }).slice(
                  0,
                  RESULT_TEXT_MAX,
                )
              : ""
            const head = `- ${p.label} (${p.agentName}): ${now.state}${
              now.error ? ` (${now.error.code})` : ""
            }`
            return text ? `${head}\n${text}` : head
          })
          .join("\n")

      const runLead = (
        channel: ChannelRow,
        lead: AgentRow,
        task: Task,
      ): Effect.Effect<unknown, unknown, never> =>
        tasks.run(
          task.id,
          lead.id,
          Effect.gen(function* () {
            const others = memberRows(channel.id).filter((m) => m.id !== lead.id)
            const reply = yield* streamReply({
              channel,
              agent: lead,
              taskId: task.id,
              kind: "text",
              system: channelSystem(channel, lead, LEAD_RULES(others.map((m) => m.name))),
              turns: channelTurns(channel.id, lead),
              hideRaw: true,
            })
            const plan: ParsedPlan | null = parsePlan(
              reply.text,
              others.map((m) => m.name),
            )
            if (!plan) {
              // An ordinary answer. A reply that only looked like JSON shows as written.
              emitMessage(reply.id)
              return
            }
            // The reply becomes the plan message, and each part becomes a task of a member.
            db.run(
              "UPDATE channel_message SET kind = 'plan', parts = ?, task_id = ? WHERE id = ?",
              JSON.stringify([{ kind: "text", text: planText(plan) }]),
              task.id,
              reply.id,
            )
            const partTasks: { task: Task; agent: AgentRow; prompt: string }[] = []
            for (const part of plan.parts) {
              const member = others.find((m) => m.name === part.member)
              const agent = member ? agentRow(member.id) : undefined
              if (!agent) continue
              const partTask = yield* tasks.create({
                agentId: agent.id,
                prompt: part.prompt,
                label: part.label,
                source: "channel",
                sourceId: channel.id,
                parentId: task.id,
              })
              partTasks.push({ task: partTask, agent, prompt: part.prompt })
            }
            emitMessage(reply.id)
            yield* Effect.forEach(
              partTasks,
              ({ task: partTask, agent, prompt }) =>
                Effect.exit(
                  memberTurn(
                    channel,
                    agent,
                    partTask,
                    `Your part: ${partTask.label}\n${prompt}`,
                    "text",
                    lead,
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            )
            emitMessage(reply.id)

            // All parts ended: the lead sums them up, also when some failed.
            const ended = tasks.children(task.id)
            const turns = channelTurns(channel.id, lead)
            turns.push({
              role: "user",
              content: `All parts have ended:\n${partReport(ended)}\nWrite one short summary for the user. If a part failed, say so and what you suggest.`,
            })
            const summary = yield* streamReply({
              channel,
              agent: lead,
              taskId: task.id,
              kind: "summary",
              system: channelSystem(channel, lead),
              turns,
            })
            void summary
          }),
        )

      const startLead = (
        channel: ChannelRow,
        lead: AgentRow,
        text: string,
        retryOf: string | null = null,
      ) =>
        Effect.gen(function* () {
          const task = yield* tasks.create({
            agentId: lead.id,
            prompt: text,
            source: "channel",
            sourceId: channel.id,
            retryOf,
          })
          yield* background(runLead(channel, lead, task))
        })

      tasks.onRetry("channel", (task) =>
        Effect.gen(function* () {
          const channel = task.sourceId ? channelRow(task.sourceId) : undefined
          if (!channel) return yield* new AppError({ code: "channel_not_found" })
          const agent = agentRow(task.agentId)
          if (!agent) return yield* new AppError({ code: "agent_not_found" })
          if (task.parentId) {
            // One part again: the member answers in the channel, with a link to the old part.
            const part = yield* tasks.create({
              agentId: agent.id,
              prompt: task.prompt,
              label: task.label,
              source: "channel",
              sourceId: channel.id,
              parentId: task.parentId,
              retryOf: task.id,
            })
            const lead = channel.lead_agent_id ? agentRow(channel.lead_agent_id) : undefined
            yield* background(
              memberTurn(
                channel,
                agent,
                part,
                `Your part: ${part.label}\n${task.prompt}`,
                "text",
                lead ?? null,
              ),
            )
          } else if (channel.lead_agent_id === agent.id) {
            yield* startLead(channel, agent, task.prompt, task.id)
          } else {
            yield* startDirect(channel, agent.id, task.prompt, task.id)
          }
        }),
      )

      // --- service methods -------------------------------------------------

      const checkName = (serverId: string, name: string, exceptId: string | null) =>
        Effect.suspend(() => {
          const length = charLength(name)
          if (length < 1 || length > CHANNEL_NAME_MAX)
            return Effect.fail(new AppError({ code: "invalid_input" }))
          const taken = db.get<{ id: string }>(
            "SELECT id FROM channel WHERE server_id = ? AND name_key = ? AND id != ?",
            serverId,
            name.toLocaleLowerCase(),
            exceptId ?? "",
          )
          return taken ? Effect.fail(new AppError({ code: "channel_name_taken" })) : Effect.void
        })

      const checkMembers = (
        serverId: string,
        memberIds: readonly string[],
        leadId: string | null,
      ) =>
        Effect.suspend(() => {
          for (const id of memberIds) {
            const row = db.get<{ server_id: string; archived_at: number | null }>(
              "SELECT server_id, archived_at FROM agent WHERE id = ?",
              id,
            )
            if (!row || row.server_id !== serverId || row.archived_at !== null)
              return Effect.fail(new AppError({ code: "agent_not_found" }))
          }
          if (leadId !== null && !memberIds.includes(leadId))
            return Effect.fail(new AppError({ code: "invalid_lead" }))
          return Effect.void
        })

      const writeMembers = (channelId: string, memberIds: readonly string[]) => {
        db.run("DELETE FROM channel_member WHERE channel_id = ?", channelId)
        for (const [position, id] of memberIds.entries()) {
          db.run(
            "INSERT INTO channel_member (channel_id, agent_id, position) VALUES (?, ?, ?)",
            channelId,
            id,
            position,
          )
        }
      }

      const changed = (channel: ChannelRow) => {
        placesChanged(channel.server_id)
        bus.emit("channels.changed", { channelId: channel.id })
      }

      const create = Effect.fn("Channels.create")(function* (input: ChannelCreate) {
        const name = input.name.trim()
        const topic = input.topic.trim()
        if (charLength(topic) > CHANNEL_TOPIC_MAX)
          return yield* new AppError({ code: "invalid_input" })
        const memberIds = [...new Set(input.memberIds)]
        yield* checkName(input.serverId, name, null)
        yield* checkMembers(input.serverId, memberIds, input.leadId)
        const sectionId = yield* sections.check(input.serverId, "channel", input.sectionId ?? null)
        const id = randomUUID()
        const now = Date.now()
        db.transaction(() => {
          db.run(
            `INSERT INTO channel (id, server_id, name, name_key, topic, lead_agent_id, place_section_id,
              created_at, updated_at, last_read_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            input.serverId,
            name,
            name.toLocaleLowerCase(),
            topic,
            input.leadId,
            sectionId,
            now,
            now,
            now,
          )
          writeMembers(id, memberIds)
        })
        const row = channelRow(id) as ChannelRow
        changed(row)
        return toChannel(row)
      })

      const get = (id: string) =>
        Effect.suspend(() => {
          const row = channelRow(id)
          return row
            ? Effect.succeed(toChannel(row))
            : Effect.fail(new AppError({ code: "channel_not_found" }))
        })

      const update = Effect.fn("Channels.update")(function* (id: string, patch: ChannelPatch) {
        const row = channelRow(id)
        if (!row) return yield* new AppError({ code: "channel_not_found" })
        const current = toChannel(row)
        const name = patch.name !== undefined ? patch.name.trim() : row.name
        const topic = patch.topic !== undefined ? patch.topic.trim() : row.topic
        if (charLength(topic) > CHANNEL_TOPIC_MAX)
          return yield* new AppError({ code: "invalid_input" })
        const memberIds = patch.memberIds ? [...new Set(patch.memberIds)] : [...current.memberIds]
        const leadId =
          patch.leadId !== undefined
            ? patch.leadId
            : memberIds.includes(current.leadId ?? "")
              ? current.leadId
              : null
        yield* checkName(row.server_id, name, id)
        yield* checkMembers(row.server_id, memberIds, leadId)
        const sectionId =
          patch.sectionId !== undefined
            ? yield* sections.check(row.server_id, "channel", patch.sectionId)
            : row.place_section_id
        // A member that works in this channel stays until its part ends or the user stops it.
        for (const removed of current.memberIds.filter((m) => !memberIds.includes(m))) {
          const busy = db.get(
            `SELECT 1 AS x FROM task WHERE source = 'channel' AND source_id = ? AND agent_id = ?
             AND state IN ${ACTIVE}`,
            id,
            removed,
          )
          if (busy) return yield* new AppError({ code: "member_working" })
        }
        db.transaction(() => {
          db.run(
            `UPDATE channel SET name = ?, name_key = ?, topic = ?, lead_agent_id = ?, place_section_id = ?,
              updated_at = ? WHERE id = ?`,
            name,
            name.toLocaleLowerCase(),
            topic,
            leadId,
            sectionId,
            Date.now(),
            id,
          )
          if (patch.memberIds) writeMembers(id, memberIds)
        })
        const next = channelRow(id) as ChannelRow
        changed(next)
        return toChannel(next)
      })

      const stopAll = (channelId: string) =>
        Effect.gen(function* () {
          const roots = db.all<{ id: string }>(
            `SELECT id FROM task WHERE source = 'channel' AND source_id = ? AND parent_id IS NULL
             AND state IN ${ACTIVE}`,
            channelId,
          )
          for (const root of roots) yield* tasks.stop(root.id)
        })

      const remove = Effect.fn("Channels.remove")(function* (id: string) {
        const row = channelRow(id)
        if (!row) return yield* new AppError({ code: "channel_not_found" })
        yield* stopAll(id)
        db.transaction(() => {
          db.run("DELETE FROM task WHERE source = 'channel' AND source_id = ?", id)
          db.run("DELETE FROM channel WHERE id = ?", id)
        })
        placesChanged(row.server_id)
      })

      const messageHandlers: ((channelId: string, text: string) => void)[] = []
      const post = (channelId: string, text: string) =>
        Effect.suspend(() => {
          const channel = channelRow(channelId)
          if (!channel) return Effect.fail(new AppError({ code: "channel_not_found" }))
          insertUserMessage(channelId, text, false)
          placesChanged(channel.server_id)
          return Effect.void
        })

      const send = Effect.fn("Channels.send")(function* (channelId: string, text: string) {
        const sender = yield* CurrentActor
        const channel = channelRow(channelId)
        if (!channel) return yield* new AppError({ code: "channel_not_found" })
        const value = text.trim()
        if (!value || value.length > MESSAGE_MAX)
          return yield* new AppError({ code: "invalid_input" })
        const members = memberRows(channelId)
        if (members.length === 0) return yield* new AppError({ code: "channel_empty" })
        const mentioned = parseMentions(
          value,
          members.map((m) => m.name),
        )
        const lead = toChannel(channel).leadId
        const awaiting = mentioned.length === 0 && lead === null
        insertUserMessage(channelId, value, awaiting, sender)
        placesChanged(channel.server_id)
        for (const handler of messageHandlers) handler(channelId, value)
        if (awaiting) return { awaiting: true }
        if (mentioned.length > 0) {
          for (const name of mentioned) {
            const member = members.find((m) => m.name === name)
            if (member) yield* startDirect(channel, member.id, value)
          }
        } else {
          const leadAgent = agentRow(lead as string)
          if (leadAgent) yield* startLead(channel, leadAgent, value)
        }
        return { awaiting: false }
      })

      const assign = Effect.fn("Channels.assign")(function* (
        channelId: string,
        messageId: string,
        agentId: string,
      ) {
        const channel = channelRow(channelId)
        const message = messageRow(messageId)
        if (!channel || !message || message.channel_id !== channelId)
          return yield* new AppError({ code: "channel_not_found" })
        if (!message.awaiting) return yield* new AppError({ code: "job_already_taken" })
        if (!memberRows(channelId).some((m) => m.id === agentId))
          return yield* new AppError({ code: "agent_not_found" })
        db.run("UPDATE channel_message SET awaiting = 0 WHERE id = ?", messageId)
        emitMessage(messageId)
        yield* startDirect(
          channel,
          agentId,
          messageText({ parts: JSON.parse(message.parts) as MessagePart[] }),
        )
      })

      const activity = (channelId: string) =>
        Effect.gen(function* () {
          const channel = channelRow(channelId)
          if (!channel) return { members: [] }
          const lead = toChannel(channel).leadId
          const states = new Map<string, MemberState>()
          for (const a of yield* agents.list(channel.server_id, false)) states.set(a.id, a.state)
          // The newest lead job that still runs. Its parts are the plan steps.
          const job = db.get<{ id: string }>(
            `SELECT id FROM task WHERE source = 'channel' AND source_id = ? AND parent_id IS NULL
             AND state IN ${ACTIVE} AND EXISTS (SELECT 1 FROM task c WHERE c.parent_id = task.id)
             ORDER BY created_at DESC LIMIT 1`,
            channelId,
          )
          const steps = job
            ? tasks
                .children(job.id)
                .filter((t) => t.state !== "cancelled")
                .slice(0, PLAN_STEPS_MAX)
                .map((t) => ({
                  taskId: t.id,
                  label: stepLabel(t.label),
                  state: t.state as TaskState,
                }))
            : []
          return {
            members: memberRows(channelId).map((m) => ({
              agentId: m.id,
              state: states.get(m.id) ?? "offline",
              steps: m.id === lead ? steps : [],
            })),
          }
        })

      return Channels.of({
        announce: (messageId) => emitMessage(messageId),
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<ChannelRow>(
                `SELECT id, server_id, name, topic, lead_agent_id, place_section_id FROM channel
                 WHERE server_id = ? ORDER BY name_key`,
                serverId,
              )
              .map(toChannel),
          ),
        get,
        create,
        update,
        remove,
        history: (channelId) =>
          Effect.sync(() =>
            db
              .all<MessageRow>(
                "SELECT * FROM channel_message WHERE channel_id = ? ORDER BY created_at, rowid",
                channelId,
              )
              .map(toMessage),
          ),
        send,
        assign,
        stopAll,
        post,
        onUserMessage: (handler) => {
          messageHandlers.push(handler)
        },
        hearUserMessage: (channelId, text) => {
          for (const handler of messageHandlers) handler(channelId, text)
        },
        runRoutine,
        activity,
        markRead: (channelId) =>
          Effect.sync(() => {
            db.run("UPDATE channel SET last_read_at = ? WHERE id = ?", Date.now(), channelId)
            const row = channelRow(channelId)
            if (row) placesChanged(row.server_id)
          }),
        lastMessage: (channelId) => {
          const row = db.get<{ parts: string }>(
            "SELECT parts FROM channel_message WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            channelId,
          )
          if (!row) return null
          const text = messageText({ parts: JSON.parse(row.parts) as MessagePart[] })
            .replace(/\s+/g, " ")
            .trim()
          return text ? text.slice(0, LAST_MESSAGE_MAX) : null
        },
      })
    }),
  )
}
