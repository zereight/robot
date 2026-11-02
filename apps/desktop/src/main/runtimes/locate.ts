import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { isRuntimeKind, type RuntimeKind, SIGN_IN_ID } from "@robot/shared"

const NAMES: Record<RuntimeKind, string> = {
  claude_code: "claude",
  codex: "codex",
  muse: "muse",
  pi: "pi",
}

export const binaryName = (kind: RuntimeKind, platform = process.platform) =>
  `${NAMES[kind]}${platform === "win32" ? (kind === "pi" ? ".cmd" : ".exe") : ""}`

/** Where the app keeps the copy that it downloaded. */
export const managedDir = (dataDir: string, kind: RuntimeKind) => join(dataDir, "runtimes", kind)

/**
 * The folder of one separate sign-in. It is next to the downloaded programs and not inside their
 * folder, which the install cleans. The id is checked, because it becomes a folder name.
 */
export const signInDir = (dataDir: string, kind: RuntimeKind, signIn: string) => {
  if (!SIGN_IN_ID.test(signIn)) throw new Error("The id of the sign-in is not valid.")
  return join(dataDir, "sign-ins", kind, signIn)
}

/** The environment variable that points tests, or a user with an odd setup, to a program. */
export const overrideVariable = (kind: RuntimeKind) =>
  `ROBOT_${kind === "claude_code" ? "CLAUDE" : kind.toUpperCase()}_BIN`

const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"]

export interface Found {
  readonly path: string
  readonly source: "app" | "system"
}

const isFile = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== "win32") accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The version that the last install wrote, or null. */
export const managedVersion = (dataDir: string, kind: RuntimeKind): string | null => {
  try {
    const text = readFileSync(join(managedDir(dataDir, kind), "current.json"), "utf8")
    const version = (JSON.parse(text) as { version?: unknown }).version
    return typeof version === "string" && /^[\w.-]+$/.test(version) ? version : null
  } catch {
    return null
  }
}

export const managedPath = (dataDir: string, kind: RuntimeKind, platform = process.platform) => {
  const version = managedVersion(dataDir, kind)
  return version ? join(managedDir(dataDir, kind), version, binaryName(kind, platform)) : null
}

/** Places where each program is usually installed, for an app that does not see the user's PATH. */
const wellKnown = (kind: RuntimeKind, home: string) => {
  const name = binaryName(kind)
  const local = join(home, ".local", "bin", name)
  if (kind === "claude_code") return [local, join(home, ".claude", "local", name)]
  if (kind === "pi")
    return [local, join(home, ".npm-global", "bin", name), join(home, ".bun", "bin", name)]
  return [local]
}

/**
 * Finds the program. A download of the app comes first. A path in the environment comes next; when
 * one is set, the search of the computer is skipped, so that a test or a user with an odd setup
 * decides which program runs. Then the PATH, then the usual places.
 */
export const findBinary = (
  kind: RuntimeKind,
  options: {
    dataDir: string
    env?: NodeJS.ProcessEnv
    home?: string
    /** Folders searched after the PATH. A desktop app often has a short PATH. */
    extraDirs?: readonly string[]
  },
): Found | null => {
  const env = options.env ?? process.env
  const managed = managedPath(options.dataDir, kind)
  if (managed && isFile(managed)) return { path: managed, source: "app" }
  const override = env[overrideVariable(kind)]
  if (override) return isFile(override) ? { path: override, source: "system" } : null
  const name = binaryName(kind)
  const extra = options.extraDirs ?? (process.platform === "win32" ? [] : EXTRA_DIRS)
  const dirs = [...(env.PATH ?? "").split(delimiter), ...extra].filter(Boolean)
  for (const dir of dirs) {
    const path = join(dir, name)
    if (isFile(path)) return { path, source: "system" }
  }
  for (const path of wellKnown(kind, options.home ?? homedir()))
    if (isFile(path)) return { path, source: "system" }
  return null
}

// ---- the places where the app saw a program --------------------------------------------

/**
 * The file where the app keeps the last place where it found each program. It is how the app
 * knows that a program "was" somewhere: a place that is gone is a program that needs repair, and a
 * program that was never seen is not installed (spec 006). It holds paths and nothing else.
 */
const placesFile = (dataDir: string) => join(dataDir, "runtimes", "places.json")

const readPlaces = (dataDir: string): Partial<Record<RuntimeKind, string>> => {
  try {
    const parsed = JSON.parse(readFileSync(placesFile(dataDir), "utf8")) as Record<string, unknown>
    const places: Partial<Record<RuntimeKind, string>> = {}
    for (const [kind, path] of Object.entries(parsed))
      if (isRuntimeKind(kind) && typeof path === "string" && path) places[kind] = path
    return places
  } catch {
    return {}
  }
}

/** Keeps the place where a program was found. A failure to write changes nothing else. */
export const rememberPlace = (dataDir: string, kind: RuntimeKind, path: string) => {
  try {
    const places = readPlaces(dataDir)
    if (places[kind] === path) return
    places[kind] = path
    mkdirSync(dirname(placesFile(dataDir)), { recursive: true })
    const temporary = `${placesFile(dataDir)}.tmp`
    writeFileSync(temporary, JSON.stringify(places))
    renameSync(temporary, placesFile(dataDir))
  } catch {
    // The memory is a help for the message. The look goes on without it.
  }
}

/**
 * A place where the app knew the program before, or null: the copy that it downloaded, or the
 * place where it last found the program. A path that was only set in the environment is not a
 * place that the app knew: the user may point it at nothing to say that there is no program.
 */
export const knownPlace = (dataDir: string, kind: RuntimeKind): string | null =>
  managedPath(dataDir, kind) ?? readPlaces(dataDir)[kind] ?? null
