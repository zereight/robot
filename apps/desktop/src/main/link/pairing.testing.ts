import { inspect } from "node:util"
import type { JoinRequest, PairingState } from "@robot/shared"
import { Effect } from "effect"
import { Devices } from "../services/Devices.ts"
import { Remote } from "../services/Remote.ts"
import type { testRuntime } from "../services/testing.ts"

type Rt = ReturnType<typeof testRuntime>

/**
 * Reads until `ok` holds. A wait that ends with no result fails at once, and the message says
 * what the test waited for (`what`) and the last value, so the test never goes on with a value
 * that is not there. With a type guard for `ok`, the result has the type of the guard.
 */
export const waitFor = async <T, U extends T = T>(
  what: string,
  read: () => Promise<T> | T,
  ok: ((v: T) => v is U) | ((v: T) => boolean),
  ms = 8000,
): Promise<U> => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 40))
    last = await read()
  }
  if (!ok(last)) {
    throw new Error(`${what} in ${ms} ms (the last value: ${inspect(last, { depth: 2 })})`)
  }
  return last as U
}

/** A message for a failure: the code of an error of the app when it has one. */
const reason = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === "string") return code
  return error instanceof Error ? error.message : String(error)
}

/** Runs one step of the pairing. A failure names the step and the reason, and keeps the cause. */
const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run()
  } catch (error) {
    throw new Error(`pairing: ${what}: ${reason(error)}`, { cause: error })
  }
}

export type PairOptions = {
  /** The switch of the Allow dialog. With none, the server decides without it. */
  canChange?: boolean | undefined
  /** The link works in both ways: the server can open the client too. */
  twoWay?: boolean
  /** Wait until the client sees the server online. The default is true. */
  online?: boolean
  /** The time of each wait, in ms. The default is 8000. */
  waitMs?: number
}

/**
 * Pairs `client` with `server` with the copied link: the client opens the link of the server, the
 * user of the server allows, and the client goes online. Every step that fails is named in the
 * message, and a join request that does not come is reported as the failure of the client when
 * the client failed first.
 */
export const pairRuntimes = async (
  server: Rt,
  client: Rt,
  { canChange, twoWay = false, online = true, waitMs = 8000 }: PairOptions = {},
) => {
  const pairing: PairingState = await step("the server did not start a pairing", () =>
    server.runtime.runPromise(Devices.use((d) => d.pairStart())),
  )
  const where = pairing.addresses.map((a) => a.address).join(", ")
  const found = await step(`the client could not open the link of the server (${where})`, () =>
    client.runtime.runPromise(Remote.use((r) => r.probe({ link: pairing.link }))),
  )
  const done = step("the client could not finish", () =>
    client.runtime.runPromise(Remote.use((r) => r.finish(found.session, twoWay))),
  )
  // The client answers when the server decides. If it fails before that, the join request never
  // comes, and the failure of the client is the cause: say that and not the wait.
  let finishFailure: unknown
  done.catch((error: unknown) => {
    finishFailure = error
  })
  const request = await waitFor(
    "pairing: the join request did not arrive",
    () => server.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.joins()[0]))),
    (j): j is JoinRequest => j !== undefined,
    waitMs,
  ).catch((error: unknown) => {
    throw finishFailure ?? error
  })
  await step("the server could not decide", () =>
    server.runtime.runPromise(
      Devices.use((d) =>
        d.decide(request.id, true, ...(canChange === undefined ? [] : [canChange])),
      ),
    ),
  )
  const entry = await done
  if (online) {
    await waitFor(
      "pairing: the client did not go online",
      () => client.runtime.runPromise(Remote.use((r) => Effect.sync(() => r.stateOf(entry.id)))),
      (state) => state === "online",
      waitMs,
    )
  }
  return { entry, pairing }
}
