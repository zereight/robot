import { ASK_RETRY_MS, ASK_TRIES, answerError, parseYesNo, retryableFailure } from "@robot/shared"
import { Cause, Effect } from "effect"
import { AppError } from "./errors.ts"

/** What the model is told to do. */
export const ASK_SYSTEM =
  "You answer one yes or no question about a text. Reply with the single word yes or no. Do not explain."

/** The last line is fixed: a model reads it as the form of the answer. */
export const ASK_REPLY_LINE = "Reply with yes or no only."

/** The message that asks a model a yes or no question about an input. */
export const askPrompt = (question: string, input: string) =>
  `Question: ${question}\n\nText:\n${input}\n\n${ASK_REPLY_LINE}`

/**
 * Whether an account of this kind can answer a prompt with no tools and no chat. Muse Code
 * cannot: its program has no run without a chat. A step that names such an account still gets it.
 */
export const canAnswerPlainPrompt = (kind: string) => kind !== "muse"

export type Tried<A> =
  | { readonly ok: true; readonly value: A; readonly tries: number }
  | { readonly ok: false; readonly error: AppError; readonly tries: number }

/**
 * Calls `attempt` up to `tries` times, `delayMs` apart. Only a plain failure of the call is tried
 * again (see `retryableFailure`). A usage limit, a busy model and any other failure end it at
 * once. A stop or a shutdown interrupts the call and is not a failure: it passes on as it is.
 */
export const withTries = <A>(
  attempt: Effect.Effect<A, AppError>,
  options: { readonly tries?: number; readonly delayMs?: number } = {},
): Effect.Effect<Tried<A>> =>
  Effect.gen(function* () {
    const tries = options.tries ?? ASK_TRIES
    const delayMs = options.delayMs ?? ASK_RETRY_MS
    for (let n = 1; ; n++) {
      const exit = yield* Effect.exit(attempt)
      if (exit._tag === "Success") return { ok: true as const, value: exit.value, tries: n }
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
      const failure = Cause.squash(exit.cause)
      const error =
        failure instanceof AppError
          ? failure
          : new AppError({ code: "internal", detail: String(failure) })
      if (n >= tries || !retryableFailure(error.code))
        return { ok: false as const, error, tries: n }
      yield* Effect.sleep(delayMs)
    }
  })

/**
 * The outcome of a condition in mode "ask" from the answer of the model: the branch, or the
 * error that holds the start of the answer.
 */
export const readVerdict = (
  answer: string,
): { readonly branch: "yes" | "no" } | { readonly error: string } => {
  const verdict = parseYesNo(answer)
  return verdict ? { branch: verdict } : { error: answerError(answer) }
}
