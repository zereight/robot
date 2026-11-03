import {
  draftName,
  type MessagePart,
  messageText,
  outsideOfParts,
  SKILL_FROM_WORK_SYSTEM,
  type SkillDraftResult,
  type SkillSource,
  type SkillSourceRef,
  skillRequest,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { ActionLog } from "./ActionLog.ts"
import { Database } from "./Database.ts"
import { DECISION_KEY } from "./Decision.ts"
import { askForDraft, draftOf } from "./draftRequest.ts"
import { AppError } from "./errors.ts"
import { Knowledge } from "./Knowledge.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { SavedSecrets } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"
import { Skills } from "./Skills.ts"
import { Tasks } from "./Tasks.ts"

export interface SkillDraftsService {
  /**
   * Asks the model account of the agent of the source for a draft skill (spec 017, "Make a skill
   * from work"). One request. It makes no task and no message, and it saves nothing. A request
   * that `cancel` dropped fails with the code "cancelled".
   */
  draft(requestId: string, source: SkillSourceRef): Effect.Effect<SkillDraftResult, AppError>
  /** Drops a request: the model call stops and its answer is not used. */
  cancel(requestId: string): Effect.Effect<void>
}

/** What the app reads from a source, before it builds the request. */
interface Work {
  readonly agentId: string
  readonly source: SkillSource
  /** The name of the draft when the model gives none. */
  readonly title: string
  readonly outside: boolean
}

export class SkillDrafts extends Context.Service<SkillDrafts, SkillDraftsService>()(
  "robot/main/SkillDrafts",
) {
  static readonly layer = Layer.effect(
    SkillDrafts,
    Effect.gen(function* () {
      const db = yield* Database
      const platform = yield* Platform
      const providers = yield* Providers
      const secrets = yield* Secrets
      const savedSecrets = yield* SavedSecrets
      const skills = yield* Skills
      const tasks = yield* Tasks
      const log = yield* ActionLog
      const knowledge = yield* Knowledge
      // A request that waits for the model. `cancel` aborts it.
      const pending = new Map<string, AbortController>()

      /** The keys and values that a text must not hold (spec 014), as the export hides them. */
      const knownSecrets = () =>
        Effect.gen(function* () {
          return [
            ...(yield* providers.list)
              .map((a) => secrets.get(secretKey(a.id)))
              .filter((k): k is string => k !== null),
            ...[secrets.get(DECISION_KEY)].filter((k): k is string => k !== null),
            ...savedSecrets.knownValues(),
          ]
        })

      const taskWork = (id: string) =>
        Effect.gen(function* () {
          const { task, joined } = yield* tasks.get(id)
          if (task.state !== "done") return yield* new AppError({ code: "skill_task_not_done" })
          const message = task.messageId
            ? (db.get<{ parts: string }>(
                "SELECT parts FROM message WHERE id = ?",
                task.messageId,
              ) ??
              db.get<{ parts: string }>(
                "SELECT parts FROM channel_message WHERE id = ?",
                task.messageId,
              ))
            : undefined
          const parts: MessagePart[] = message ? (JSON.parse(message.parts) as MessagePart[]) : []
          const entries = log.ofTask(task.id)
          // The turn held outside content when a step of it did, when its reply shows a step that
          // gave outside text, or when another agent started it (spec 007).
          const outside =
            entries.some((e) => e.outside !== null) ||
            outsideOfParts(parts) !== null ||
            task.source === "agent"
          return {
            agentId: task.agentId,
            title: task.label,
            outside,
            source: {
              kind: "task",
              prompt: task.prompt,
              joined: joined.map((j) => j.text),
              reply: messageText({ parts }),
              // A task that came by sync ran on the other computer: its steps are not here.
              // A step that was refused did not run, so it is no part of the work.
              steps:
                task.originName !== null
                  ? null
                  : tasks
                      .steps(task.id)
                      .filter((s) => s.result !== "refused")
                      .map((s) => ({ kind: s.kind, target: s.target })),
            },
          } satisfies Work
        })

      const work = (ref: SkillSourceRef): Effect.Effect<Work, AppError> => {
        switch (ref.kind) {
          case "task":
            return taskWork(ref.id)
          case "article":
            return Effect.gen(function* () {
              const article = yield* knowledge.get(ref.agentId, ref.file)
              return {
                agentId: ref.agentId,
                title: article.title,
                outside: false,
                source: {
                  kind: "article",
                  title: article.title,
                  summary: article.summary,
                  body: article.body,
                },
              } satisfies Work
            })
          case "memory":
            return Effect.gen(function* () {
              const item = db.get<{ agent_id: string; text: string }>(
                "SELECT agent_id, text FROM memory WHERE id = ?",
                ref.id,
              )
              if (!item) return yield* new AppError({ code: "memory_not_found" })
              return {
                agentId: item.agent_id,
                title: item.text,
                outside: false,
                source: { kind: "memory", text: item.text },
              } satisfies Work
            })
        }
      }

      return SkillDrafts.of({
        cancel: (requestId) =>
          Effect.sync(() => {
            pending.get(requestId)?.abort()
          }),
        draft: (requestId, ref) =>
          Effect.gen(function* () {
            const found = yield* work(ref)
            const agent = db.get<{ name: string; server_id: string }>(
              "SELECT name, server_id FROM agent WHERE id = ?",
              found.agentId,
            )
            if (!agent) return yield* new AppError({ code: "agent_not_found" })
            const controller = new AbortController()
            pending.set(requestId, controller)
            const request = skillRequest(found.source, yield* knownSecrets())
            const answer = yield* askForDraft(
              { db, providers, dataDir: platform.dataDir },
              found.agentId,
              SKILL_FROM_WORK_SYSTEM,
              request,
              controller.signal,
            ).pipe(
              Effect.ensuring(Effect.sync(() => void pending.delete(requestId))),
              // The user closed the form: the answer, or the failure, is dropped.
              Effect.catch((error) =>
                controller.signal.aborted
                  ? Effect.fail(new AppError({ code: "cancelled" }))
                  : Effect.fail(error),
              ),
            )
            if (controller.signal.aborted) return yield* new AppError({ code: "cancelled" })
            const draft = draftOf(answer, found.title.split("\n")[0] ?? "")
            if (!draft) return yield* new AppError({ code: "teach_draft_empty" })
            return {
              agentId: found.agentId,
              agentName: agent.name,
              draft: {
                name: draftName(draft.name, found.title, (name) =>
                  skills.nameTaken(agent.server_id, name),
                ),
                description: draft.description,
                instructions: draft.instructions,
              },
              outside: found.outside,
            } satisfies SkillDraftResult
          }),
      })
    }),
  )
}
