import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { parseDraft, type TeachDraft } from "@robot/shared"
import { Effect } from "effect"
import type { DatabaseService } from "./Database.ts"
import { AppError } from "./errors.ts"
import { type ProvidersService, toAppError } from "./Providers.ts"
import { canAnswerPlainPrompt } from "./workflowAsk.ts"

/** What a draft request needs from the app. */
export interface DraftDeps {
  readonly db: DatabaseService
  readonly providers: ProvidersService
  /** The data folder of the app. A request runs in a scratch folder inside it. */
  readonly dataDir: string
}

/**
 * One request to the model account of an agent, for a draft skill: a system text and one message,
 * no tools, no chat and no task (spec 017). "Teach a task" and "Make a skill from work" both ask
 * this way. The answer is the text of the reply. A stop of the caller (`signal`) or an interrupt
 * of the effect aborts the request.
 */
export const askForDraft = (
  deps: DraftDeps,
  agentId: string,
  system: string,
  message: string,
  signal?: AbortSignal,
): Effect.Effect<string, AppError> =>
  Effect.gen(function* () {
    const agent = deps.db.get<{ model_account_id: string | null; model_name: string | null }>(
      "SELECT model_account_id, model_name FROM agent WHERE id = ?",
      agentId,
    )
    if (!agent?.model_account_id || !agent.model_name)
      return yield* new AppError({ code: "provider_not_connected" })
    const account = (yield* deps.providers.list).find((a) => a.id === agent.model_account_id)
    if (!account?.connected) return yield* new AppError({ code: "provider_not_connected" })
    if (!canAnswerPlainPrompt(account.kind))
      return yield* new AppError({ code: "teach_model_unusable" })
    const scratch = join(deps.dataDir, "scratch")
    mkdirSync(scratch, { recursive: true })
    const controller = new AbortController()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener("abort", () => controller.abort(), { once: true })
    const events = yield* deps.providers.events(
      account.id,
      {
        model: agent.model_name,
        effort: null,
        system,
        turns: [{ role: "user", content: message }],
        signal: controller.signal,
        workspace: scratch,
        permission: "ask_all",
        useTools: false,
      },
      { execute: async () => ({ output: "", failed: true }), approve: async () => false },
    )
    return yield* Effect.tryPromise({
      try: async () => {
        let text = ""
        for await (const event of events) if (event.type === "text") text += event.text
        return text
      },
      catch: toAppError,
    }).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
  })

/**
 * The draft in the answer of the model. An answer that is not the asked form becomes the
 * instructions, and the result text gives the name. An empty answer gives `undefined`.
 */
export const draftOf = (answer: string, result: string): TeachDraft | undefined => {
  const parsed = parseDraft(answer)
  if (parsed) return parsed.name ? parsed : { ...parsed, name: [...result].slice(0, 40).join("") }
  const text = answer.trim()
  if (!text) return undefined
  return {
    name: [...result].slice(0, 40).join("").trim(),
    description: "",
    instructions: text.slice(0, 20_000),
  }
}
