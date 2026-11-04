import { afterEach, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "../test-temp.ts"
import {
  isSameProgram,
  type Observed,
  parseElapsed,
  programName,
  type RecordedProgram,
  spawnProgram,
  startPrograms,
  stopPrograms,
} from "./programs.ts"

const posix = process.platform !== "win32"

describe("the identity of a program", () => {
  const record: RecordedProgram = {
    pid: 4242,
    command: "/usr/local/bin/claude",
    startedAt: 1_000_000,
  }
  const seen = (extra: Partial<Observed> = {}): Observed => ({
    startedAt: 1_000_500,
    command: "/usr/local/bin/claude -p --verbose",
    ...extra,
  })

  test("the same number, a start time that fits, and the name of the program", () => {
    expect(isSameProgram(record, seen())).toBe(true)
  })

  test("a process that has taken the number later is not the program", () => {
    expect(isSameProgram(record, seen({ startedAt: 1_000_000 + 10 * 60_000 }))).toBe(false)
  })

  test("a process with another name is not the program", () => {
    expect(isSameProgram(record, seen({ command: "/usr/bin/vim notes.txt" }))).toBe(false)
  })

  test("no process is no program", () => {
    expect(isSameProgram(record, null)).toBe(false)
  })

  test("a stand-in that runs through another program still shows the name of the script", () => {
    const standIn = { ...record, command: "/tmp/fake/claude" }
    expect(isSameProgram(standIn, seen({ command: "node /tmp/fake/claude.mjs -p" }))).toBe(true)
  })

  test("the name is the file name without the folder and the extension", () => {
    expect(programName("C:\\Tools\\Claude.exe")).toBe("claude")
    expect(programName("/opt/pi")).toBe("pi")
  })

  test("the elapsed time of a process reads in the three forms of ps", () => {
    expect(parseElapsed("05:07")).toBe(307_000)
    expect(parseElapsed(" 01:05:07 ")).toBe(3_907_000)
    expect(parseElapsed("2-01:05:07")).toBe(((2 * 24 + 1) * 3600 + 5 * 60 + 7) * 1000)
    expect(parseElapsed("soon")).toBeNull()
  })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitUntil = async (check: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await Bun.sleep(25)
  }
  throw new Error("timed out")
}

describe.skipIf(!posix)("leftover programs", () => {
  const started: ChildProcess[] = []
  afterEach(() => {
    stopPrograms()
    for (const child of started.splice(0)) child.kill("SIGKILL")
  })
  const dir = () => tempDir("robot-programs-")
  const list = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { programs: unknown[] }

  test("a program of an earlier run that still runs is ended at the start, and one of the user is not", async () => {
    const file = join(dir(), "running-programs.json")
    // The earlier run: it starts a program and writes it down. Then it dies and never ends it.
    await startPrograms(file)
    const mine = spawnProgram("sleep", ["30"], { stdio: "ignore" })
    started.push(mine)
    const pid = mine.pid as number
    expect(list(file).programs).toHaveLength(1)
    // The user started a program with the same name by hand. It is not on the list.
    const theirs = spawn("sleep", ["31"], { stdio: "ignore" })
    started.push(theirs)
    const theirPid = theirs.pid as number
    // The earlier run was a different process; the app now writes the list as the earlier run.
    const raw = JSON.parse(readFileSync(file, "utf8")) as { owner: number; programs: unknown[] }
    writeFileSync(file, JSON.stringify({ ...raw, owner: 999_999 }))

    const ended = await startPrograms(file)
    expect(ended).toEqual([pid])
    await waitUntil(() => !alive(pid))
    expect(alive(theirPid)).toBe(true)
    // The new list is empty again.
    expect(list(file).programs).toEqual([])
  })

  test("a program that has ended by itself is taken off the list", async () => {
    const file = join(dir(), "running-programs.json")
    await startPrograms(file)
    const child = spawnProgram("sleep", ["0.1"], { stdio: "ignore" })
    started.push(child)
    expect(list(file).programs).toHaveLength(1)
    await new Promise((resolve) => child.once("exit", resolve))
    await waitUntil(() => list(file).programs.length === 0)
  })

  test("a process that has taken the number of a program is not ended", async () => {
    const file = join(dir(), "running-programs.json")
    const other = spawn("sleep", ["30"], { stdio: "ignore" })
    started.push(other)
    const pid = other.pid as number
    // The list names that number, but another program and another time.
    writeFileSync(
      file,
      JSON.stringify({
        owner: 999_999,
        programs: [{ pid, command: "/usr/local/bin/claude", startedAt: Date.now() }],
      }),
    )
    expect(await startPrograms(file)).toEqual([])
    expect(alive(pid)).toBe(true)
  })

  test("the programs of a copy of the app that still runs are left alone", async () => {
    const file = join(dir(), "running-programs.json")
    const other = spawn("sleep", ["30"], { stdio: "ignore" })
    started.push(other)
    const pid = other.pid as number
    // The owner of the list is this very process: another copy cannot be told apart here, so the
    // list names a live owner that is not the current process. A parent process stands for it.
    writeFileSync(
      file,
      JSON.stringify({
        owner: process.ppid,
        programs: [{ pid, command: "sleep", startedAt: Date.now() }],
      }),
    )
    const ended = await startPrograms(file, async (n) =>
      n === process.ppid
        ? { startedAt: Date.now(), command: process.execPath }
        : { startedAt: Date.now(), command: "sleep 30" },
    )
    expect(ended).toEqual([])
    expect(alive(pid)).toBe(true)
  })

  test("a list that cannot be read, or that is empty, ends nothing", async () => {
    const file = join(dir(), "running-programs.json")
    writeFileSync(file, "{ not json")
    expect(await startPrograms(file)).toEqual([])
    expect(await startPrograms(join(dir(), "none.json"))).toEqual([])
  })
})
