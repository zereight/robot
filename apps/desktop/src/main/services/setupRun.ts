/**
 * Runs the setup actions of a workspace (spec 035). The list comes from `robot.json`. A turn runs
 * the marked actions only after the user has allowed that list on this computer.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import {
  formatSetupFile,
  parseSetupFile,
  SETUP_FILE_MAX_BYTES,
  SETUP_FILE_NAME,
  SETUP_TIMEOUT_MS,
  type SetupAction,
  type SetupActionInput,
  type SetupFailCode,
  type SetupFailure,
  type SetupFileView,
  type SetupList,
  type SetupRunResult,
  type SetupSaveResult,
  setupCanon,
  setupInfo,
} from "@robot/shared"

export interface RunOptions {
  readonly signal?: AbortSignal
  /** The time the actions of this call share, in milliseconds. Tests make it short. */
  readonly limitMs?: number
}

type RunCode = SetupFailCode | "ok" | "aborted"

interface Loaded {
  readonly actions: readonly SetupAction[]
  readonly hash: string
  readonly unreadable: boolean
  /** The main checkout when the workspace is a linked worktree. */
  readonly origin: string | undefined
}

interface AllowStore {
  readonly allowed: readonly string[]
  readonly ownCopy: Readonly<Record<string, string>>
}

const ALLOW_FILE = "setup-allow.json"
const ALLOW_MAX = 100
const COPY_MAX = 200
const WALK_MAX = 32

const emptyAllow = (): AllowStore => ({ allowed: [], ownCopy: {} })

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The folder that holds `.git` for this workspace, walking up from the workspace. */
function enclosingGit(start: string): string | undefined {
  let dir = resolve(start)
  for (let step = 0; step < WALK_MAX; step++) {
    if (existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * The main checkout of a linked worktree, read from the `.git` file. A main checkout has no
 * origin of its own.
 */
function mainCheckout(workspace: string): string | undefined {
  const gitRoot = enclosingGit(workspace)
  if (!gitRoot) return undefined
  const git = join(gitRoot, ".git")
  if (isDir(git)) return undefined
  let gitdir: string
  try {
    const line = readFileSync(git, "utf8")
      .split("\n")
      .find((item) => item.startsWith("gitdir:"))
    const raw = line?.slice("gitdir:".length).trim()
    if (!raw) return undefined
    gitdir = isAbsolute(raw) ? raw : resolve(gitRoot, raw)
  } catch {
    return undefined
  }
  let common: string
  try {
    const rel = readFileSync(join(gitdir, "commondir"), "utf8").trim()
    common = realpathSync(isAbsolute(rel) ? rel : resolve(gitdir, rel))
  } catch {
    return undefined
  }
  const origin = dirname(common)
  if (!isDir(origin)) return undefined
  try {
    if (realpathSync(origin) === realpathSync(gitRoot)) return undefined
  } catch {
    return undefined
  }
  return origin
}

/** The setup file for this workspace: here, at the Git root, or in the main checkout. */
function findSetupFile(workspace: string): string | undefined {
  const dir = resolve(workspace)
  if (!isDir(dir)) return undefined
  const local = join(dir, SETUP_FILE_NAME)
  if (isFile(local)) return local
  const gitRoot = enclosingGit(dir)
  if (gitRoot && gitRoot !== dir) {
    const atRoot = join(gitRoot, SETUP_FILE_NAME)
    if (isFile(atRoot)) return atRoot
  }
  const origin = mainCheckout(dir)
  if (!origin) return undefined
  const atOrigin = join(origin, SETUP_FILE_NAME)
  return isFile(atOrigin) ? atOrigin : undefined
}

function readSetupText(path: string): { readonly text: string } | { readonly unreadable: true } {
  try {
    if (statSync(path).size > SETUP_FILE_MAX_BYTES) return { unreadable: true }
    return { text: readFileSync(path, "utf8") }
  } catch {
    return { unreadable: true }
  }
}

function hashOf(actions: readonly SetupAction[]): string {
  return createHash("sha256").update(setupCanon(actions)).digest("hex")
}

function load(workspace: string): Loaded {
  const origin = isDir(resolve(workspace)) ? mainCheckout(workspace) : undefined
  const path = findSetupFile(workspace)
  if (!path) return { actions: [], hash: "", unreadable: false, origin }
  const read = readSetupText(path)
  if ("unreadable" in read) return { actions: [], hash: "", unreadable: true, origin }
  const parsed = parseSetupFile(read.text)
  if (!parsed.ok) return { actions: [], hash: "", unreadable: true, origin }
  return { actions: parsed.actions, hash: hashOf(parsed.actions), unreadable: false, origin }
}

function readField(item: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(item, key)?.value
}

function readAllow(dataDir: string): AllowStore {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, ALLOW_FILE), "utf8"))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyAllow()
    const allowedRaw = readField(value, "allowed")
    const copyRaw = readField(value, "ownCopy")
    const allowed =
      Array.isArray(allowedRaw) && allowedRaw.every((item) => typeof item === "string")
        ? allowedRaw.slice(-ALLOW_MAX)
        : []
    const ownCopy: Record<string, string> = {}
    if (typeof copyRaw === "object" && copyRaw !== null && !Array.isArray(copyRaw)) {
      for (const key of Object.keys(copyRaw).slice(0, COPY_MAX)) {
        const field = readField(copyRaw, key)
        if (typeof field === "string") ownCopy[key] = field
      }
    }
    return { allowed, ownCopy }
  } catch {
    return emptyAllow()
  }
}

function writeAllow(dataDir: string, store: AllowStore): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      join(dataDir, ALLOW_FILE),
      JSON.stringify({ allowed: store.allowed.slice(-ALLOW_MAX), ownCopy: store.ownCopy }),
    )
  } catch {
    // The next turn still sees the old choice.
  }
}

function rememberHash(hashes: readonly string[], hash: string): readonly string[] {
  return [...hashes.filter((item) => item !== hash), hash].slice(-ALLOW_MAX)
}

function rememberCopy(
  map: Readonly<Record<string, string>>,
  path: string,
  hash: string,
): Record<string, string> {
  const keys = Object.keys(map).filter((key) => key !== path)
  const kept = keys.length >= COPY_MAX ? keys.slice(keys.length - COPY_MAX + 1) : keys
  const next: Record<string, string> = {}
  for (const key of kept) {
    const value = map[key]
    if (value !== undefined) next[key] = value
  }
  next[path] = hash
  return next
}

function lockKey(workspace: string): string {
  const path = resolve(workspace)
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const tails = new Map<string, Promise<unknown>>()

function oneAtATime<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  const run = prev.then(job, job)
  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

function commandEnv(cwd: string, origin: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ROBOT_ORIGIN
  delete env.ROBOT_WORKSPACE
  env.ROBOT_WORKSPACE = cwd
  if (origin) env.ROBOT_ORIGIN = origin
  return env
}

function killGroup(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

/** Runs one command in the workspace. The time is what this command may still use. */
function runOne(
  action: SetupAction,
  cwd: string,
  origin: string | undefined,
  signal: AbortSignal | undefined,
  limitMs: number,
): Promise<RunCode> {
  if (signal?.aborted) return Promise.resolve("aborted")
  if (limitMs <= 0) return Promise.resolve("timeout")
  let child: ChildProcess
  try {
    child = spawn("/bin/sh", ["-c", action.command], {
      cwd,
      env: commandEnv(cwd, origin),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
  } catch {
    return Promise.resolve("spawn")
  }
  return new Promise((done) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => killGroup(child)
    const finish = (code: RunCode) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      done(code)
    }
    let timedOut = false
    timer = setTimeout(() => {
      timedOut = true
      killGroup(child)
    }, limitMs)
    signal?.addEventListener("abort", onAbort, { once: true })
    const discard = () => undefined
    child.stdout?.on("data", discard)
    child.stderr?.on("data", discard)
    child.on("error", () => finish("spawn"))
    child.on("close", (code) => {
      if (signal?.aborted) return finish("aborted")
      if (timedOut) return finish("timeout")
      finish(code === 0 ? "ok" : "exit")
    })
  })
}

function listOf(dataDir: string, loaded: Loaded): SetupList {
  if (loaded.unreadable) return { actions: [], allowed: false, unreadable: true }
  const allow = readAllow(dataDir)
  return {
    actions: setupInfo(loaded.actions),
    allowed: loaded.hash !== "" && allow.allowed.includes(loaded.hash),
    unreadable: false,
  }
}

/** The menu for the chat header. */
export function listSetup(dataDir: string, workspace: string): SetupList {
  return listOf(dataDir, load(workspace))
}

/** The file the editor shows: the shared file, or the file a save would make. */
export function readSetupFile(workspace: string): SetupFileView {
  const found = findSetupFile(workspace)
  if (!found)
    return {
      path: join(resolve(workspace), SETUP_FILE_NAME),
      exists: false,
      unreadable: false,
      actions: [],
    }
  const read = readSetupText(found)
  if ("unreadable" in read) return { path: found, exists: true, unreadable: true, actions: [] }
  const parsed = parseSetupFile(read.text)
  if (!parsed.ok) return { path: found, exists: true, unreadable: true, actions: [] }
  return { path: found, exists: true, unreadable: false, actions: setupInfo(parsed.actions) }
}

/**
 * Writes the list from the editor. A save to a workspace with no file makes it there. An
 * unreadable file is replaced only after the user has confirmed it. A save that changes the
 * list clears the allow, because the allow follows the text.
 */
export function writeSetupFile(
  dataDir: string,
  workspace: string,
  actions: readonly SetupActionInput[],
  replace: boolean,
): SetupSaveResult {
  const dir = resolve(workspace)
  if (!isDir(dir)) return { status: "missing" }
  const found = findSetupFile(workspace)
  let existing: string | undefined
  if (found) {
    const read = readSetupText(found)
    if ("unreadable" in read || !parseSetupFile(read.text).ok) {
      if (!replace) return { status: "unreadable" }
    } else {
      existing = read.text
    }
  }
  const formatted = formatSetupFile(existing, actions)
  if (!formatted.ok) return { status: "invalid" }
  try {
    writeFileSync(found ?? join(dir, SETUP_FILE_NAME), formatted.text)
  } catch {
    return { status: "missing" }
  }
  return { status: "saved", list: listSetup(dataDir, workspace) }
}

/** Allows or stops automatic runs of the list that is in the workspace now. */
export function setSetupAllowed(dataDir: string, workspace: string, on: boolean): SetupList {
  const loaded = load(workspace)
  if (!loaded.unreadable && loaded.hash !== "") {
    const allow = readAllow(dataDir)
    const allowed = on
      ? rememberHash(allow.allowed, loaded.hash)
      : allow.allowed.filter((item) => item !== loaded.hash)
    writeAllow(dataDir, { allowed, ownCopy: allow.ownCopy })
  }
  return listOf(dataDir, loaded)
}

/** Runs the named action. The user picked it, so the allow does not apply. */
export function runNamed(
  workspace: string,
  name: string,
  options: RunOptions = {},
): Promise<SetupRunResult> {
  return oneAtATime(lockKey(workspace), async () => {
    const loaded = load(workspace)
    const action = loaded.actions.find((item) => item.name === name)
    if (!action) return { status: "missing" }
    const code = await runOne(
      action,
      resolve(workspace),
      loaded.origin,
      options.signal,
      options.limitMs ?? SETUP_TIMEOUT_MS,
    )
    if (code === "ok") return { status: "ran" }
    if (code === "aborted") return { status: "failed", code: "spawn" }
    return { status: "failed", code }
  })
}

interface TurnRun {
  readonly failures: SetupFailure[]
  readonly stop: boolean
}

/** Runs the actions that this moment asks for. A timeout ends the rest of the turn's actions. */
async function runMarked(
  actions: readonly SetupAction[],
  take: (action: SetupAction, index: number) => boolean,
  cwd: string,
  origin: string | undefined,
  signal: AbortSignal | undefined,
  deadline: number,
  ran: Set<number>,
): Promise<TurnRun> {
  const failures: SetupFailure[] = []
  for (const [index, action] of actions.entries()) {
    if (!take(action, index) || ran.has(index)) continue
    if (signal?.aborted) return { failures, stop: true }
    const code = await runOne(action, cwd, origin, signal, deadline - Date.now())
    if (code === "aborted") return { failures, stop: true }
    ran.add(index)
    if (code === "ok") continue
    failures.push({ name: action.name, code })
    if (code === "timeout") return { failures, stop: true }
  }
  return { failures, stop: false }
}

/**
 * The actions of one turn. Own-copy actions run on the first turn in a linked worktree. Turn
 * actions run on every turn. Nothing runs until the user has allowed this list.
 */
export function prepareTurn(
  dataDir: string,
  workspace: string,
  options: RunOptions = {},
): Promise<readonly SetupFailure[]> {
  return oneAtATime(lockKey(workspace), () => runTurn(dataDir, workspace, options))
}

async function runTurn(
  dataDir: string,
  workspace: string,
  options: RunOptions,
): Promise<readonly SetupFailure[]> {
  if (options.signal?.aborted) return []
  const loaded = load(workspace)
  if (loaded.unreadable || loaded.actions.length === 0 || loaded.hash === "") return []
  if (!readAllow(dataDir).allowed.includes(loaded.hash)) return []
  const cwd = resolve(workspace)
  const real = lockKey(workspace)
  const deadline = Date.now() + (options.limitMs ?? SETUP_TIMEOUT_MS)
  const ran = new Set<number>()
  const marked = readAllow(dataDir).ownCopy[real]
  const wantsOwn = loaded.origin !== undefined && loaded.actions.some((action) => action.onOwnCopy)
  const runOwn = wantsOwn && marked !== loaded.hash
  const own = runOwn
    ? await runMarked(
        loaded.actions,
        (action) => action.onOwnCopy,
        cwd,
        loaded.origin,
        options.signal,
        deadline,
        ran,
      )
    : { failures: [], stop: false }
  if (
    runOwn &&
    !own.stop &&
    !options.signal?.aborted &&
    own.failures.length === 0 &&
    loaded.actions.some((action) => action.onOwnCopy)
  ) {
    const fresh = readAllow(dataDir)
    writeAllow(dataDir, {
      allowed: fresh.allowed,
      ownCopy: rememberCopy(fresh.ownCopy, real, loaded.hash),
    })
  }
  if (own.stop) return own.failures
  const turn = await runMarked(
    loaded.actions,
    (action) => action.onTurnStart,
    cwd,
    loaded.origin,
    options.signal,
    deadline,
    ran,
  )
  return [...own.failures, ...turn.failures]
}
