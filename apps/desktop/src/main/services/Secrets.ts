import { execFileSync } from "node:child_process"
import { Context, Layer } from "effect"

export interface SecretsService {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  /** Throws when the keychain cannot be read (spec 020, "Keychain error"). */
  check(): void
}

/** Exit code of `robot-host secrets get` when the store holds no value. */
const NO_VALUE = 3

const exitCode = (error: unknown) =>
  typeof error === "object" && error !== null && "status" in error ? error.status : undefined

/** The store of the host program, with the values that were read kept in memory. */
export const hostStore = (command: string, file?: string): SecretsService => {
  const known = new Map<string, string | null>()
  const run = (args: string[], input?: string) =>
    execFileSync(command, ["secrets", ...args, ...(file ? ["--file", file] : [])], {
      encoding: "utf8",
      // stderr holds the reason only, never a value.
      stdio: ["pipe", "pipe", "pipe"],
      ...(input !== undefined ? { input } : {}),
    })
  return {
    get: (key) => {
      if (known.has(key)) return known.get(key) ?? null
      let value: string | null
      try {
        value = run(["get", key])
      } catch (error) {
        if (exitCode(error) !== NO_VALUE) throw new Error("The keychain could not be read")
        value = null
      }
      known.set(key, value)
      return value
    },
    set: (key, value) => {
      known.delete(key)
      try {
        run(["set", key], value)
      } catch {
        throw new Error("The keychain could not be written")
      }
      known.set(key, value)
    },
    remove: (key) => {
      known.delete(key)
      try {
        run(["remove", key])
      } catch {
        throw new Error("The keychain could not be written")
      }
      known.set(key, null)
    },
    check: () => {
      // A key that was never written reads as no value (exit 3) when the store can be read.
      try {
        run(["get", `probe:${Date.now().toString(36)}`])
      } catch (error) {
        if (exitCode(error) !== NO_VALUE) throw new Error("The keychain could not be read")
      }
    },
  }
}

/** Keys and tokens. They live in the system keychain and nowhere else. */
export class Secrets extends Context.Service<Secrets, SecretsService>()("robot/main/Secrets") {
  /**
   * The store of the host program (`host/src/secrets.rs`): the system keychain, or with `file`
   * the file store of end-to-end tests. Each read or write is one short run of the host that the
   * main process waits for, so the calls stay synchronous. Values that were read once are kept in
   * memory: only this app writes them.
   */
  static readonly host = (command: string, file?: string) =>
    Layer.sync(Secrets, () => Secrets.of(hostStore(command, file)))

  /** Keeps secrets in memory. For unit tests. */
  static readonly memory = Layer.sync(Secrets, () => {
    const store = new Map<string, string>()
    return Secrets.of({
      get: (key) => store.get(key) ?? null,
      set: (key, value) => void store.set(key, value),
      remove: (key) => void store.delete(key),
      check: () => {},
    })
  })
}
