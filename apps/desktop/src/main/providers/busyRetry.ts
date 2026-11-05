import { ProviderFailure } from "./client.ts"

/** How many times the app tries a busy request again (spec 006, "Busy provider"). */
export const BUSY_TRIES = 3

/** The wait before each new try, in ms: 2, 4 and 8 seconds. */
export const BUSY_WAIT_MS = [2_000, 4_000, 8_000] as const

/**
 * The waits the app uses. A test sets short waits. The app uses {@link BUSY_WAIT_MS}.
 */
export const busyClock = {
  waitsMs: [...BUSY_WAIT_MS] as number[],
}

/** The chat shows a muted line for each wait, and counts the wait and the new try as a sign of life. */
export interface BusyWait {
  /** The wait starts. `n` is 1, 2 or 3. */
  wait(n: number): void
  /** The new try starts. */
  again(): void
}

function isOutput(type: string) {
  return type === "text" || type === "thinking" || type === "toolcall" || type === "reply"
}

function busyFailure(error: unknown): error is ProviderFailure {
  return error instanceof ProviderFailure && error.code === "provider_busy"
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The wait was stopped.")
}

/** Waits `ms`, or ends at once when `signal` aborts. Stop ends the wait (spec 006). */
export function sleepBusy(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    if (ms <= 0) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(abortError(signal))
    }
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort)
  })
}

export interface BusyRetryOptions {
  readonly signal: AbortSignal
  readonly onWait: (n: number) => void
  readonly onTry: () => void
  /** Absent means {@link busyClock}. A test passes short waits. */
  readonly waitsMs?: readonly number[]
}

/**
 * Runs `open` again when the provider is busy and the request has made no output yet (spec 006).
 * It tries again up to 3 times. After the third try a busy failure is thrown as it is.
 * A request that already yielded text, thinking or a tool call is not tried again.
 */
export async function* withBusyRetries<E extends { readonly type: string }>(
  open: () => AsyncIterable<E>,
  options: BusyRetryOptions,
): AsyncGenerator<E> {
  const waits = options.waitsMs ?? busyClock.waitsMs
  for (let attempt = 0; ; attempt++) {
    let produced = false
    try {
      for await (const event of open()) {
        if (isOutput(event.type)) produced = true
        yield event
      }
      return
    } catch (error) {
      if (produced || options.signal.aborted || attempt >= BUSY_TRIES || !busyFailure(error))
        throw error
      const n = attempt + 1
      options.onWait(n)
      await sleepBusy(waits[attempt] ?? waits[waits.length - 1] ?? 0, options.signal)
      options.onTry()
    }
  }
}
