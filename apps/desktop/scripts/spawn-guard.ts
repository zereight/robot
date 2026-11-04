// A child process for a test, with a guard against a stall.
//
// Some tests of the judge scripts start a child process and wait for it. On a busy computer, a
// group of such tests once ended at their time limit with no output at all, and nobody could say
// where the child had stopped. `spawnGuarded` starts the child as `Bun.spawn` does and gives the
// same result. When the child has not ended after the limit, it collects what can explain the stall
// (the processes, the output so far, on macOS a sample of the stack), kills the child and its
// descendants, and fails with that text.
import { loadavg } from "node:os"

export type SpawnResult = { code: number; out: string; err: string }

export type SpawnGuardOptions = {
  /** The working folder of the child. */
  cwd?: string
  /** The whole environment of the child, as `Bun.spawn` takes it. It is never put in a message. */
  env?: Record<string, string | undefined>
  /** The seconds that the child may run. The default is 15. */
  limitSeconds?: number
  /** Take a sample of the stack of a stalled child on macOS. The default is true. */
  sample?: boolean
}

/** The failure of a stalled child. The message holds everything that is known about it. */
export class ChildStalled extends Error {
  readonly pid: number
  readonly waitedSeconds: number
  constructor(message: string, pid: number, waitedSeconds: number) {
    super(message)
    this.name = "ChildStalled"
    this.pid = pid
    this.waitedSeconds = waitedSeconds
  }
}

export const DEFAULT_LIMIT_SECONDS = 15
/** The time that `ps` or `sample` may take. A tool that stalls too must not stall the test. */
const TOOL_LIMIT_MS = 5_000
/** The time that a killed child may take to end. */
const KILL_LIMIT_MS = 5_000
/** The time that the pipes of a killed child may take to close. */
const PIPE_LIMIT_MS = 1_000
const OUTPUT_MAX = 4_000
const SAMPLE_MAX = 6_000
/** A child can start more processes. The stack of the child alone would not show the one that waits. */
const SAMPLE_PROCESSES_MAX = 3
const TREE_LINES_MAX = 30

/** Reads a pipe in pieces, so that the text so far is known while the child still runs. */
const collect = (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  const ended = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      chunks.push(next.value)
    }
  })()
  return {
    ended,
    cancel: () => reader.cancel().catch(() => {}),
    text: () => new TextDecoder().decode(Buffer.concat(chunks)),
  }
}

/** The result of `work`, or `undefined` when `work` is not done after `ms`. */
const within = async <T>(work: Promise<T>, ms: number): Promise<{ value: T } | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((done) => {
    timer = setTimeout(() => done(undefined), ms)
  })
  try {
    return await Promise.race([work.then((value) => ({ value })), late])
  } finally {
    clearTimeout(timer)
  }
}

const seconds = (ms: number) => (ms / 1000).toFixed(1)

/** The end of a text: what a program printed last says most. */
const tail = (text: string, max: number) =>
  text.length <= max
    ? text
    : `[the first ${text.length - max} characters are cut]\n${text.slice(-max)}`

const head = (text: string, max: number) =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n[${text.length - max} more characters are cut]`

/** Runs a tool of the system with a time limit. It never throws and never waits for a stalled tool. */
const runTool = async (command: string[]): Promise<string> => {
  try {
    const tool = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
    const out = collect(tool.stdout)
    const err = collect(tool.stderr)
    const finished = Promise.all([out.ended, err.ended, tool.exited])
    const done = await within(finished, TOOL_LIMIT_MS)
    if (!done) {
      tool.kill("SIGKILL")
      await within(finished, PIPE_LIMIT_MS)
      await Promise.all([out.cancel(), err.cancel()])
      return `${out.text()}\n(${command[0]} was killed after ${seconds(TOOL_LIMIT_MS)} s)`
    }
    const [, , code] = done.value
    return code === 0 && out.text().trim() !== ""
      ? out.text()
      : `${out.text()}\n(${command[0]} ended with code ${code})\n${err.text()}`
  } catch (error) {
    return `(${command[0]} could not run: ${error instanceof Error ? error.message : String(error)})`
  }
}

type Row = { pid: number; ppid: number; line: string }

/** The table of processes of the system, as rows. A row holds the state, the age and the command. */
const processTable = async (): Promise<Row[] | string> => {
  if (process.platform === "win32") return "(the process table is not read on this system)"
  const text = await runTool(["ps", "-A", "-o", "pid=,ppid=,stat=,etime=,command="])
  const rows: Row[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+.*)$/.exec(line)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), line: line.trim() })
  }
  return rows.length > 0 ? rows : `(no process table: ${head(text.trim(), 300)})`
}

/** The child and every process that it started and that still has it as parent, in table order. */
const familyOf = (rows: Row[], pid: number) => {
  const family = new Set([pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows)
      if (family.has(row.ppid) && !family.has(row.pid)) {
        family.add(row.pid)
        grew = true
      }
  }
  return rows.filter((row) => family.has(row.pid))
}

/** The stack of a process, on macOS. Elsewhere, and when `sample` fails, the text says so. */
const sampleOf = async (pid: number): Promise<string> => {
  if (process.platform !== "darwin") return "(sample skipped: this is not macOS)"
  // "-file /dev/stdout" keeps the report out of a file in the folder for temporary files.
  const text = await runTool(["sample", String(pid), "1", "-file", "/dev/stdout"])
  // The list of loaded libraries after the call graph is long and tells nothing about a stall.
  return head(text.split("\nBinary Images:")[0]?.trim() ?? "", SAMPLE_MAX)
}

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // The process is already gone.
  }
}

/**
 * Starts `command` as `Bun.spawn` does, with both outputs as pipes, and returns the exit code and
 * the text of both outputs. Without a stall the result is the one that a plain `Bun.spawn` and a
 * read of both pipes gives: a non-zero exit code is a result, not an error.
 *
 * A child that has not ended after the limit (and, if its pipes stay open, a child that has ended
 * but whose output has not) makes the call throw a `ChildStalled`. The child and its descendants
 * are dead when it throws.
 */
export const spawnGuarded = async (
  command: string[],
  options: SpawnGuardOptions = {},
): Promise<SpawnResult> => {
  const { limitSeconds = DEFAULT_LIMIT_SECONDS, sample = true, cwd, env } = options
  const child = Bun.spawn(command, {
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const started = performance.now()
  const out = collect(child.stdout)
  const err = collect(child.stderr)
  const finished = Promise.all([out.ended, err.ended, child.exited])
  const done = await within(finished, limitSeconds * 1000)
  if (done) return { code: done.value[2], out: out.text(), err: err.text() }

  const waited = performance.now() - started
  // The child can have ended while a process that it started holds the pipes open.
  const exited = child.exitCode !== null || child.signalCode !== null
  const table = await processTable()
  const family = typeof table === "string" ? [] : familyOf(table, child.pid)
  const samples = !sample
    ? "(sample was not asked for)"
    : exited
      ? "(sample skipped: the child had already ended)"
      : (
          await Promise.all(
            [...new Set([child.pid, ...family.map((row) => row.pid)])]
              .slice(0, SAMPLE_PROCESSES_MAX)
              .map(async (pid) => `--- sample of pid ${pid} ---\n${await sampleOf(pid)}`),
          )
        ).join("\n")

  for (const row of family) if (row.pid !== child.pid) kill(row.pid)
  try {
    child.kill("SIGKILL")
  } catch {
    // The child is already gone.
  }
  const gone = await within(child.exited, KILL_LIMIT_MS)
  await within(
    Promise.all([out.ended, err.ended]).catch(() => {}),
    PIPE_LIMIT_MS,
  )
  await Promise.all([out.cancel(), err.cancel()])
  const stdout = out.text()
  const stderr = err.text()

  const state = exited
    ? `the child had ended (code ${child.exitCode}, signal ${child.signalCode}), but its output pipes were still open`
    : "the child was still running"
  const lines = [
    `The child process did not finish in ${seconds(limitSeconds * 1000)} s. The guard killed it.`,
    `command: ${JSON.stringify(command)}`,
    `working folder: ${cwd ?? process.cwd()}`,
    `pid: ${child.pid}`,
    `waited: ${seconds(waited)} s (limit ${limitSeconds} s)`,
    `state at the limit: ${state}`,
    `after the kill: ${gone ? "the child has ended" : `the child did not end within ${seconds(KILL_LIMIT_MS)} s`}`,
    `load average (1, 5, 15 minutes): ${loadavg()
      .map((n) => n.toFixed(2))
      .join(" ")}`,
    typeof table === "string"
      ? `processes of the child: ${table}`
      : `processes of the child (pid, ppid, state, age, command):\n${
          family.length > 0
            ? head(
                family
                  .slice(0, TREE_LINES_MAX)
                  .map((row) => `  ${row.line.slice(0, 200)}`)
                  .join("\n"),
                4_000,
              )
            : "  (the child is not in the table of processes)"
        }`,
    `stdout so far (${stdout.length} characters):\n${stdout === "" ? "(nothing)" : tail(stdout, OUTPUT_MAX)}`,
    `stderr so far (${stderr.length} characters):\n${stderr === "" ? "(nothing)" : tail(stderr, OUTPUT_MAX)}`,
    samples,
  ]
  throw new ChildStalled(lines.join("\n"), child.pid, waited / 1000)
}
