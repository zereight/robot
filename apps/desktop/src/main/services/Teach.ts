import {
  addStep,
  type Skill,
  type SkillInput,
  TEACH_RESULT_MAX,
  TEACH_STEPS_MAX,
  TEACH_SYSTEM,
  TEACH_TIME_MAX_MS,
  type TeachDraft,
  type TeachEvent,
  type TeachLimit,
  type TeachState,
  type TeachStep,
  teachPrompt,
  toStep,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "./Database.ts"
import { askForDraft, draftOf } from "./draftRequest.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { Providers } from "./Providers.ts"
import { Skills } from "./Skills.ts"
import { Tools } from "./Tools.ts"

export interface TeachService {
  readonly state: Effect.Effect<TeachState>
  /**
   * Starts a recording: the browser of the agent opens with the user in control. One recording
   * runs at a time on this computer.
   */
  start(agentId: string, result: string): Effect.Effect<TeachState, AppError>
  /** Opens an address in the browser that the user teaches with. */
  open(url: string): Effect.Effect<void, AppError>
  pause(paused: boolean): Effect.Effect<void, AppError>
  /**
   * Ends the recording and asks the model of the agent for a draft skill. A recording with no
   * steps makes no draft: it ends, and the answer says so.
   */
  stop: Effect.Effect<{ readonly empty: boolean }, AppError>
  /** Ends the recording and keeps nothing. */
  cancel: Effect.Effect<void>
  /** Asks the model again after a failed request. */
  retry: Effect.Effect<void, AppError>
  /** Saves the draft as a skill for this agent only, turned on. The recording is deleted. */
  save(input: SkillInput): Effect.Effect<Skill, AppError>
  /** Throws the draft and the recording away. After a save, it closes the card. */
  discard: Effect.Effect<void>
}

interface Session {
  readonly agentId: string
  readonly agentName: string
  readonly result: string
  phase: "recording" | "drafting" | "draft" | "failed" | "saved"
  steps: readonly TeachStep[]
  /** The number of recorded steps. It stays after the recording is deleted. */
  count: number
  paused: boolean
  /** Recorded time before `since`. */
  elapsedMs: number
  /** When the recording last went on. */
  since: number
  limit: TeachLimit | null
  draft: TeachDraft | null
  error: string | null
  skill: { readonly id: string; readonly name: string } | null
  timer: ReturnType<typeof setTimeout> | undefined
  request: Fiber.Fiber<void> | undefined
}

/** An address that the user typed: a web address, with "https://" when it has no scheme. */
export const teachAddress = (input: string): string | undefined => {
  const text = input.trim()
  if (!text || /\s/.test(text)) return undefined
  const full = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(full)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export class Teach extends Context.Service<Teach, TeachService>()("robot/main/Teach") {
  static readonly layer = Layer.effect(
    Teach,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const platform = yield* Platform
      const providers = yield* Providers
      const tools = yield* Tools
      const skills = yield* Skills
      // The recording is kept in memory only, on this computer (spec 014). It is gone when the
      // user saves or discards the draft, and when the app quits.
      let session: Session | undefined

      const elapsed = (s: Session, now = Date.now()) =>
        s.elapsedMs + (s.phase === "recording" && !s.paused ? now - s.since : 0)

      const snapshot = (): TeachState => {
        const s = session
        if (!s) return { phase: "idle" }
        const now = Date.now()
        if (s.phase === "recording")
          return {
            phase: "recording",
            agentId: s.agentId,
            agentName: s.agentName,
            result: s.result,
            steps: s.count,
            paused: s.paused,
            elapsedMs: elapsed(s, now),
            at: now,
          }
        return {
          phase: s.phase,
          agentId: s.agentId,
          agentName: s.agentName,
          result: s.result,
          steps: s.count,
          limit: s.limit,
          draft: s.draft,
          error: s.error,
          skill: s.skill,
        }
      }
      const changed = () => bus.emit("teach.changed", snapshot())

      /** Stops the recorder and gives the browser back to the agent. The steps stay. */
      const endRecording = (s: Session) => {
        if (s.timer) clearTimeout(s.timer)
        s.timer = undefined
        s.elapsedMs = elapsed(s)
        platform.browser(s.agentId).record(undefined)
        tools.setTeaching(s.agentId, false)
      }

      /** The time limit, from the recorded time that is left. Paused time does not count. */
      const armTimer = (s: Session) => {
        if (s.timer) clearTimeout(s.timer)
        s.timer = setTimeout(() => autoStop(s, "time"), Math.max(0, TEACH_TIME_MAX_MS - elapsed(s)))
      }

      /** One request to the model of the agent, for a draft skill. */
      const ask = (s: Session) =>
        askForDraft(
          { db, providers, dataDir: platform.dataDir },
          s.agentId,
          TEACH_SYSTEM,
          teachPrompt(s.result, s.steps),
        )

      /** Asks for the draft in the background. The card shows the outcome. */
      const requestDraft = (s: Session) => {
        s.phase = "drafting"
        s.error = null
        changed()
        s.request = Effect.runFork(
          Effect.gen(function* () {
            const exit = yield* Effect.exit(ask(s))
            if (session !== s) return
            s.request = undefined
            if (Exit.isSuccess(exit)) {
              const draft = draftOf(exit.value, s.result)
              if (draft) {
                s.phase = "draft"
                s.draft = draft
              } else {
                s.phase = "failed"
                s.error = "teach_draft_empty"
              }
            } else {
              const failure = exit.cause.reasons.find(Cause.isFailReason)
              s.phase = "failed"
              s.error = failure ? failure.error.code : "unknown"
            }
            changed()
          }),
        )
      }

      /** The recording stopped by itself: the steps so far make the draft. */
      const autoStop = (s: Session, limit: TeachLimit) => {
        if (session !== s || s.phase !== "recording") return
        endRecording(s)
        s.limit = limit
        if (s.steps.length === 0) {
          session = undefined
          changed()
          return
        }
        requestDraft(s)
      }

      const onEvent = (s: Session) => (event: TeachEvent) => {
        if (session !== s || s.phase !== "recording" || s.paused) return
        s.steps = addStep(s.steps, toStep(event))
        s.count = s.steps.length
        if (s.steps.length >= TEACH_STEPS_MAX) autoStop(s, "steps")
        else changed()
      }

      const recording = Effect.suspend(() =>
        session?.phase === "recording"
          ? Effect.succeed(session)
          : Effect.fail(new AppError({ code: "teach_not_recording" })),
      )

      /** Ends the session and forgets the recording. */
      const forget = (s: Session) => {
        if (s.phase === "recording") endRecording(s)
        if (s.request) Effect.runFork(Fiber.interrupt(s.request))
        s.request = undefined
        s.steps = []
        if (session === s) session = undefined
        changed()
      }

      return Teach.of({
        state: Effect.sync(snapshot),
        start: (agentId, result) =>
          Effect.gen(function* () {
            const text = result.trim()
            if (!text || [...text].length > TEACH_RESULT_MAX)
              return yield* new AppError({ code: "teach_result_invalid" })
            if (session)
              return yield* new AppError({ code: "teach_busy", detail: session.agentName })
            const agent = db.get<{ name: string }>(
              "SELECT name FROM agent WHERE id = ? AND archived_at IS NULL",
              agentId,
            )
            if (!agent) return yield* new AppError({ code: "agent_not_found" })
            const page = platform.browser(agentId)
            if (!page.isOpen())
              yield* Effect.tryPromise({
                try: () => page.open("about:blank"),
                catch: (e) => new AppError({ code: "teach_browser_failed", detail: String(e) }),
              })
            const s: Session = {
              agentId,
              agentName: agent.name,
              result: text,
              phase: "recording",
              steps: [],
              count: 0,
              paused: false,
              elapsedMs: 0,
              since: Date.now(),
              limit: null,
              draft: null,
              error: null,
              skill: null,
              timer: undefined,
              request: undefined,
            }
            session = s
            tools.setTeaching(agentId, true)
            page.record(onEvent(s))
            armTimer(s)
            changed()
            return snapshot()
          }),
        open: (url) =>
          Effect.gen(function* () {
            const s = yield* recording
            const address = teachAddress(url)
            if (!address) return yield* new AppError({ code: "teach_bad_address" })
            yield* Effect.tryPromise({
              try: () => platform.browser(s.agentId).open(address),
              catch: (e) => new AppError({ code: "teach_bad_address", detail: String(e) }),
            })
            // A page that was closed and opened again is a new page: the user holds it again.
            tools.setTeaching(s.agentId, true)
          }),
        pause: (paused) =>
          Effect.gen(function* () {
            const s = yield* recording
            if (s.paused === paused) return
            if (paused) {
              s.elapsedMs = elapsed(s)
              s.paused = true
              if (s.timer) clearTimeout(s.timer)
              s.timer = undefined
            } else {
              s.paused = false
              s.since = Date.now()
              armTimer(s)
            }
            changed()
          }),
        stop: Effect.gen(function* () {
          const s = yield* recording
          endRecording(s)
          if (s.steps.length === 0) {
            session = undefined
            changed()
            return { empty: true }
          }
          requestDraft(s)
          return { empty: false }
        }),
        cancel: Effect.sync(() => {
          if (session?.phase === "recording") forget(session)
        }),
        retry: Effect.gen(function* () {
          const s = session
          if (s?.phase !== "failed") return yield* new AppError({ code: "teach_not_recording" })
          requestDraft(s)
        }),
        save: (input) =>
          Effect.gen(function* () {
            const s = session
            if (s?.phase !== "draft") return yield* new AppError({ code: "teach_not_recording" })
            const skill = yield* skills.createForAgent(s.agentId, input)
            // The recording is deleted once the skill is saved (spec 014).
            s.steps = []
            s.phase = "saved"
            s.skill = { id: skill.id, name: skill.name }
            s.draft = { ...input, name: skill.name }
            changed()
            return skill
          }),
        discard: Effect.sync(() => {
          if (session && session.phase !== "recording") forget(session)
        }),
      })
    }),
  )
}

export { draftOf }
