import {
  buildCheckRequest,
  buildChoiceRequest,
  buildPickRequest,
  type CheckResult,
  type CheckTarget,
  type ChoiceResult,
  DECISION_PATH,
  DECISION_URL,
  DECISION_WAIT_MS,
  type DecisionKeys,
  type DecisionStatus,
  type DecisionTestResult,
  PERMISSION_CHECK_WAIT_MS,
  type PickInput,
  type PickResult,
  readCheckAnswer,
  readChoiceAnswer,
  readPickAnswer,
  redactSecrets,
  TEST_PICK,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { AppError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"
import { SettingsStore } from "./Settings.ts"

/** Where the key of "Jev through OpenRouter" lives in the keychain. */
export const DECISION_KEY = "decision:openrouter"

export interface DecisionService {
  /** Whether a key is saved. It never gives the key. */
  readonly status: Effect.Effect<DecisionStatus>
  /** Saves or removes the keys that the patch names. A key that is not named stays. */
  keys(patch: DecisionKeys): Effect.Effect<DecisionStatus, AppError>
  /** True when the model is on and has its key and its model name. Otherwise nobody is asked. */
  readonly ready: Effect.Effect<boolean>
  /** Asks the model to choose one member. It never fails: a failure is a result with a reason. */
  pick(input: PickInput): Effect.Effect<PickResult>
  /**
   * Asks the model of a decision node (spec 010): the question, the options and the input go to the
   * service. It gives a probability for each option. It never fails and never takes longer than 3
   * seconds: a model that is not set up, a late answer, an error and an answer that is not usable
   * are a result with no probabilities and a reason. The words of the input are cleaned of secrets.
   */
  choose(input: {
    readonly question: string
    readonly options: readonly string[]
    readonly input: string
  }): Effect.Effect<ChoiceResult>
  /** One real request with three made-up members to the saved choice (spec 013). */
  readonly test: Effect.Effect<DecisionTestResult>
  /**
   * Asks the model one question: does the user ask for this step? (spec 007, "Ask when unsure").
   * It never fails and never takes longer than 3 seconds: an error, a late answer, a model that
   * is not set up and an unsure answer are all a result that does not allow the step.
   */
  check(input: { readonly words: string; readonly target: CheckTarget }): Effect.Effect<CheckResult>
}

export class Decision extends Context.Service<Decision, DecisionService>()("robot/main/Decision") {
  /** `url` is the service address. Tests give an address on this computer. */
  static readonly layer = (options: { url?: string } = {}) =>
    Layer.effect(
      Decision,
      Effect.gen(function* () {
        const secrets = yield* Secrets
        const settings = yield* SettingsStore
        const base = options.url ?? DECISION_URL

        /** A key that this computer cannot read counts as no key (spec 013). */
        const readKey = (): string | null => {
          try {
            return secrets.get(DECISION_KEY) || null
          } catch {
            return null
          }
        }

        const status = Effect.sync(
          (): DecisionStatus => ({ keys: { openrouter: readKey() !== null } }),
        )

        const keys = (patch: DecisionKeys) =>
          Effect.try({
            try: () => {
              if (patch.openrouter === null) secrets.remove(DECISION_KEY)
              else if (patch.openrouter !== undefined) {
                const value = patch.openrouter.trim()
                if (!value) throw new AppError({ code: "invalid_input" })
                secrets.set(DECISION_KEY, value)
              }
            },
            catch: (e) => (e instanceof AppError ? e : new AppError({ code: "secret_keychain" })),
          }).pipe(Effect.flatMap(() => status))

        /** The saved choice with everything it needs, or null when anything is missing. */
        const config = Effect.gen(function* () {
          const s = yield* settings.get
          if (s.decisionModel !== "openrouter") return null
          const model = s.decisionModelName.trim()
          const key = readKey()
          return model && key ? { model, key } : null
        })

        const ask = async (
          setup: { model: string; key: string },
          input: PickInput,
        ): Promise<PickResult> => {
          const started = Date.now()
          const result = (r: Omit<PickResult, "ms">): PickResult => ({
            ...r,
            ms: Date.now() - started,
          })
          const none = (reason: NonNullable<PickResult["reason"]>, code?: number) =>
            result({
              index: null,
              reason,
              probability: null,
              ...(code !== undefined ? { code } : {}),
            })
          const timedOut = (e: unknown) =>
            e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
          // Text that looks like a key never goes out (spec 014).
          const clean = (text: string) => redactSecrets(text)
          const body = buildPickRequest(setup.model, {
            ...input,
            topic: clean(input.topic),
            job: clean(input.job),
            recent: input.recent.map((m) => ({ from: m.from, text: clean(m.text) })),
          })
          let response: Response
          try {
            response = await fetch(`${base}${DECISION_PATH}`, {
              method: "POST",
              redirect: "error",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${setup.key}`,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(DECISION_WAIT_MS),
            })
          } catch (e) {
            return none(timedOut(e) ? "timeout" : "network_error")
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            return none("service_error", response.status)
          }
          let json: unknown
          try {
            json = await response.json()
          } catch (e) {
            return none(timedOut(e) ? "timeout" : "unreadable")
          }
          const read = readPickAnswer(json, input.members.length)
          return read.ok
            ? result({ index: read.index, probability: read.probability })
            : none(read.reason)
        }

        /** One check: the same service and key as a pick, the limit of 3 seconds (spec 007). */
        const askCheck = async (
          setup: { model: string; key: string },
          input: { words: string; target: CheckTarget },
        ): Promise<CheckResult> => {
          const started = Date.now()
          const no = (
            reason: Extract<CheckResult, { allowed: false }>["reason"],
            probability: number | null = null,
          ): CheckResult => ({ allowed: false, reason, probability, ms: Date.now() - started })
          const timedOut = (e: unknown) =>
            e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
          // One signal for the whole wait: the request and the reading of the answer.
          const signal = AbortSignal.timeout(PERMISSION_CHECK_WAIT_MS)
          let response: Response
          try {
            response = await fetch(`${base}${DECISION_PATH}`, {
              method: "POST",
              redirect: "error",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${setup.key}`,
              },
              body: JSON.stringify(buildCheckRequest(setup.model, input)),
              signal,
            })
          } catch (e) {
            return no(timedOut(e) ? "timeout" : "network_error")
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            return no("service_error")
          }
          let json: unknown
          try {
            json = await response.json()
          } catch (e) {
            return no(timedOut(e) ? "timeout" : "unreadable")
          }
          const read = readCheckAnswer(json)
          return read.ok
            ? { allowed: true, probability: read.probability, ms: Date.now() - started }
            : no(read.reason, read.probability)
        }

        const check = (input: { words: string; target: CheckTarget }) =>
          Effect.gen(function* () {
            const setup = yield* config
            if (!setup)
              return {
                allowed: false,
                reason: "not_set_up",
                probability: null,
                ms: 0,
              } satisfies CheckResult as CheckResult
            return yield* Effect.promise(() => askCheck(setup, input))
          })

        const askChoice = async (
          setup: { model: string; key: string },
          input: { question: string; options: readonly string[]; input: string },
        ): Promise<ChoiceResult> => {
          const started = Date.now()
          const none = (reason: NonNullable<PickResult["reason"]>): ChoiceResult => ({
            probabilities: null,
            reason,
            ms: Date.now() - started,
          })
          const timedOut = (e: unknown) =>
            e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
          const signal = AbortSignal.timeout(DECISION_WAIT_MS)
          let response: Response
          try {
            response = await fetch(`${base}${DECISION_PATH}`, {
              method: "POST",
              redirect: "error",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${setup.key}`,
              },
              body: JSON.stringify(
                buildChoiceRequest(setup.model, {
                  question: redactSecrets(input.question),
                  options: input.options.map((o) => redactSecrets(o)),
                  input: redactSecrets(input.input),
                }),
              ),
              signal,
            })
          } catch (e) {
            return none(timedOut(e) ? "timeout" : "network_error")
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => {})
            return none("service_error")
          }
          let json: unknown
          try {
            json = await response.json()
          } catch (e) {
            return none(timedOut(e) ? "timeout" : "unreadable")
          }
          const read = readChoiceAnswer(json, input.options.length)
          return read.ok
            ? { probabilities: read.probabilities, reason: null, ms: Date.now() - started }
            : none(read.reason)
        }

        const choose = (input: { question: string; options: readonly string[]; input: string }) =>
          Effect.gen(function* () {
            const setup = yield* config
            if (!setup) return { probabilities: null, reason: "not_set_up", ms: 0 } as ChoiceResult
            return yield* Effect.promise(() => askChoice(setup, input))
          })

        const pick = (input: PickInput) =>
          Effect.gen(function* () {
            const setup = yield* config
            if (!setup)
              return { index: null, reason: "not_set_up", probability: null, ms: 0 } as PickResult
            return yield* Effect.promise(() => ask(setup, input))
          })

        const test = pick(TEST_PICK).pipe(
          Effect.map((r): DecisionTestResult => {
            if (r.index === null)
              return {
                ok: false,
                reason: r.reason ?? "unreadable",
                ...(r.code !== undefined ? { code: r.code } : {}),
                ms: r.ms,
              }
            return {
              ok: true,
              member: TEST_PICK.members[r.index]?.name ?? "",
              probability: r.probability ?? 0,
              ms: r.ms,
            }
          }),
        )

        return Decision.of({
          status,
          keys,
          ready: Effect.map(config, (c) => c !== null),
          pick,
          choose,
          test,
          check,
        })
      }),
    )
}
