import { execFile, spawn } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Vendor programs that the app started (spec 006, "Leftover programs"). The app writes down each
 * program it starts, with its process number and the time. When the app starts again, it ends
 * the programs that this list names and that still run, for example after a crash. It ends a
 * program only when the process is the one that it started: the same number, a start time that
 * fits, and the name of the program. A program that the user started is never on the list, and a
 * process that has taken over a number is not ended.
 */

export interface RecordedProgram {
  readonly pid: number
  /** The command that the app started. */
  readonly command: string
  /** When the app started it, in ms. */
  readonly startedAt: number
}

/** What the system says about a process. */
export interface Observed {
  /** When the process started, in ms. */
  readonly startedAt: number
  /** The command line. */
  readonly command: string
}

/** How far the start time of the process may differ from the time that the app wrote down. */
export const START_TOLERANCE_MS = 30_000

/** The name of a program without its folder and its extension, in lower case. */
export const programName = (command: string) => {
  const file = command.split(/[\\/]/).pop() ?? command
  const dot = file.lastIndexOf(".")
  return (dot > 0 ? file.slice(0, dot) : file).toLowerCase()
}

/** True when the process on the system is the one that the app wrote down. */
export const isSameProgram = (record: RecordedProgram, seen: Observed | null): boolean =>
  seen !== null &&
  Math.abs(seen.startedAt - record.startedAt) <= START_TOLERANCE_MS &&
  seen.command.toLowerCase().includes(programName(record.command))

/** Reads the elapsed time of `ps`: `[[dd-]hh:]mm:ss`. Returns ms, or null. */
export const parseElapsed = (text: string): number | null => {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(text)
  if (!match) return null
  const [, days, hours, minutes, seconds] = match
  return (
    ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60_000 +
    Number(seconds) * 1000
  )
}

const run = (file: string, args: readonly string[]) =>
  new Promise<string | null>((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: 5000, windowsHide: true, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout) => resolve(error ? null : stdout),
    )
  })

/** Asks the system about a process. Null when there is no such process, or when it cannot tell. */
export const observe = async (pid: number, now = Date.now()): Promise<Observed | null> => {
  if (process.platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds(); $p.CommandLine }`,
    ])
    if (!out) return null
    const [started, ...command] = out.split(/\r?\n/)
    const startedAt = Number(started)
    return Number.isFinite(startedAt) && started ? { startedAt, command: command.join(" ") } : null
  }
  const elapsed = parseElapsed((await run("ps", ["-o", "etime=", "-p", String(pid)])) ?? "")
  const command = await run("ps", ["-o", "command=", "-p", String(pid)])
  if (elapsed === null || !command?.trim()) return null
  return { startedAt: now - elapsed, command: command.trim() }
}

interface ProgramList {
  /** The process of the app that wrote the list. */
  readonly owner: number
  readonly programs: readonly RecordedProgram[]
}

const read = (file: string): ProgramList | null => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProgramList> | null
    if (typeof parsed?.owner !== "number" || !Array.isArray(parsed.programs)) return null
    return {
      owner: parsed.owner,
      programs: parsed.programs.filter(
        (p): p is RecordedProgram =>
          typeof p?.pid === "number" &&
          Number.isInteger(p.pid) &&
          p.pid > 1 &&
          typeof p.command === "string" &&
          typeof p.startedAt === "number",
      ),
    }
  } catch {
    return null
  }
}

const write = (file: string, programs: readonly RecordedProgram[]) => {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    const record: ProgramList = { owner: process.pid, programs }
    writeFileSync(temp, JSON.stringify(record))
    renameSync(temp, file)
  } catch {
    // The list is a help for the next start. A program that runs must not fail because of it.
  }
}

/** The list of this run. The app has one data folder, so it has one list. */
let listFile: string | undefined
let current: RecordedProgram[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** True when a process with this number runs. */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // No permission means that the process exists and is not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Ends a process: a polite end first, then a hard one. Windows ends the process and its children. */
const end = async (pid: number) => {
  if (process.platform === "win32") {
    await run("taskkill", ["/pid", String(pid), "/T", "/F"])
    return
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(100)
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // It ended in the meantime.
    }
  }
}

/**
 * Sets the list of this run and ends the programs that an earlier run left. The list of this
 * run starts empty. Returns the process numbers that were ended.
 */
export const startPrograms = async (
  file: string,
  inspect: (pid: number) => Promise<Observed | null> = observe,
): Promise<number[]> => {
  const earlier = read(file)
  listFile = file
  current = []
  // Another copy of the app that still runs with this data folder owns the programs on the list.
  const ownerRuns =
    earlier !== null &&
    earlier.owner !== process.pid &&
    alive(earlier.owner) &&
    (await inspect(earlier.owner))?.command.toLowerCase().includes(programName(process.execPath))
  if (ownerRuns) {
    listFile = undefined
    return []
  }
  write(file, current)
  const ended: number[] = []
  for (const record of earlier?.programs ?? []) {
    // The number is this app's own: never end the app itself.
    if (record.pid === process.pid) continue
    if (!isSameProgram(record, await inspect(record.pid))) continue
    await end(record.pid)
    ended.push(record.pid)
  }
  return ended
}

/** Stops writing a list. For tests. */
export const stopPrograms = () => {
  listFile = undefined
  current = []
}

const forget = (pid: number) => {
  current = current.filter((p) => p.pid !== pid)
  if (listFile) write(listFile, current)
}

/**
 * Starts a vendor program like `spawn`, and writes it down until it ends, so that a later run of
 * the app can end it if this run dies before it does.
 */
export const spawnProgram = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args)
  const pid = child.pid
  if (pid !== undefined && listFile) {
    current = [...current, { pid, command: String(args[0]), startedAt: Date.now() }]
    write(listFile, current)
    child.once("exit", () => forget(pid))
    child.once("error", () => forget(pid))
  }
  return child
}) as typeof spawn
