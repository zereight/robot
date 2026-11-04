import { afterAll, setDefaultTimeout } from "bun:test"
import { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
 * Each test process makes its temporary folders inside one folder of its own, and removes that
 * folder when its tests end. Before, many tests made a folder (a data folder, a home folder, an
 * upload folder) and nothing removed it. One computer had 955 000 of them in its temporary folder.
 * A program that starts in a working folder inside the temporary folder reads the folders above
 * it, so each start took 7 to 10 seconds there, against 0.1 second in a small folder. Tests that
 * start a program ran into their time limit, and each run of the tests made it worse.
 *
 * It is `afterAll` and not the `exit` event of the process: a test worker of `bun test --parallel`
 * ends with no `exit` event. A test that sets its own `TMPDIR`, for a program that it starts, is
 * not changed by this.
 */
const ownTemporaryFolder = mkdtempSync(join(tmpdir(), "robot-test-"))
for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = ownTemporaryFolder
afterAll(() => {
  rmSync(ownTemporaryFolder, { recursive: true, force: true })
})

/**
 * The link listener of a unit test listens on 127.0.0.1 only. The app listens on all addresses,
 * and the test asks the system for a free port (port 0). The system can give a port that another
 * program of the computer already holds on 127.0.0.1 or on all IPv4 addresses. Then a connection
 * to 127.0.0.1 and that port goes to the other program, not to the test. The other program
 * answered "404" or "401" at once (a tunnel agent, a development server), or never answered, and
 * the handshake of 3 seconds ran out (Tailscale). The test failed with "unreachable", in about 1
 * of 200 runs. The system gives a listener on 127.0.0.1 only a port that is free there. Measured
 * with a program that holds ports: 3 shared ports in 60 000 for all addresses, and 0 in 60 000
 * for 127.0.0.1.
 * A test server that a test reaches on 127.0.0.1 needs the same: `Bun.serve({ hostname })`.
 */
process.env.ROBOT_LINK_BIND = "127.0.0.1"

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
