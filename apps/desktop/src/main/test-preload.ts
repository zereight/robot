import { setDefaultTimeout } from "bun:test"
import { ChildProcess } from "node:child_process"
import { Readable } from "node:stream"

/**
 * The time limit of one test, when the test sets none. The limit of the test runner is 5 seconds.
 * That is too short for a shared computer: many tests start a program or a socket and wait for it,
 * and a busy computer makes the same test 5 times slower. A test that ran in 1 second failed at
 * the limit, and the failure had nothing to do with the code. A test that really hangs still
 * fails, a little later. A test that sets its own limit keeps it.
 */
setDefaultTimeout(30_000)

/**
 * Loaded before every unit test file (bunfig.toml). Test runs only; the app runs on Node.
 *
 * Under `bun test` on a busy macOS computer, `node:child_process` can emit the events of a program
 * that ends at once while `spawn()` is still running (oven-sh/bun#45483): `exit` and `close` of the
 * program, and `data` and `end` of its output. The caller adds its listeners after `spawn()`
 * returns, so it never hears them: a test waits until its time limit, or gets no output. Node
 * emits all of these later. This keeps every event that the program or its output emits inside
 * `spawn()`, and emits them again, in the same order, once `spawn()` has returned.
 */
type Held = { target: object; event: string | symbol; args: unknown[] }
let holding: Held[] | undefined

type Emitter = { emit: (this: object, event: string | symbol, ...args: unknown[]) => boolean }
const hold = (proto: Emitter) => {
  const emit = proto.emit
  proto.emit = function (event, ...args) {
    if (holding) {
      holding.push({ target: this, event, args })
      return true
    }
    return emit.call(this, event, ...args)
  }
  return emit
}
const emits = new Map<object, Emitter["emit"]>([
  [ChildProcess.prototype, hold(ChildProcess.prototype as unknown as Emitter)],
  [Readable.prototype, hold(Readable.prototype as unknown as Emitter)],
])
const emitOf = (target: object) =>
  target instanceof ChildProcess ? emits.get(ChildProcess.prototype) : emits.get(Readable.prototype)

const proto = ChildProcess.prototype as unknown as {
  spawn: (this: ChildProcess, ...args: unknown[]) => unknown
}
const spawn = proto.spawn
proto.spawn = function (...args) {
  // A spawn inside a spawn does not happen; keep the outer list if it does.
  const outer = holding
  const list: Held[] = outer ?? []
  holding = list
  try {
    return spawn.apply(this, args)
  } finally {
    holding = outer
    if (!outer && list.length > 0) {
      setImmediate(() => {
        for (const { target, event, args: eventArgs } of list)
          emitOf(target)?.call(target, event, ...eventArgs)
      })
    }
  }
}
