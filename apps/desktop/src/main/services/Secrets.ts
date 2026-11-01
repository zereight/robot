import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { Context, Layer } from "effect"

export interface SecretsService {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const SERVICE_NAME = "ROBot"

/** Keys and tokens. They live in the system keychain and nowhere else. */
export class Secrets extends Context.Service<Secrets, SecretsService>()("robot/main/Secrets") {
  /** The system keychain. */
  static readonly keychain = Layer.sync(Secrets, () => {
    // Loaded here so tests that use another store never load the native module.
    const { Entry } = createRequire(import.meta.url)(
      "@napi-rs/keyring",
    ) as typeof import("@napi-rs/keyring")
    const entry = (key: string) => new Entry(SERVICE_NAME, key)
    return Secrets.of({
      get: (key) => entry(key).getPassword(),
      set: (key, value) => entry(key).setPassword(value),
      remove: (key) => {
        entry(key).deletePassword()
      },
    })
  })

  /** Keeps secrets in memory. For unit tests. */
  static readonly memory = Layer.sync(Secrets, () => {
    const store = new Map<string, string>()
    return Secrets.of({
      get: (key) => store.get(key) ?? null,
      set: (key, value) => void store.set(key, value),
      remove: (key) => void store.delete(key),
    })
  })

  /**
   * Keeps secrets in one file outside the data folder. For end-to-end tests on machines
   * without a usable keychain; never used by a normal run.
   */
  static readonly file = (path: string) =>
    Layer.sync(Secrets, () => {
      const read = (): Record<string, string> =>
        existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
      const write = (data: Record<string, string>) => writeFileSync(path, JSON.stringify(data))
      return Secrets.of({
        get: (key) => read()[key] ?? null,
        set: (key, value) => write({ ...read(), [key]: value }),
        remove: (key) => {
          const { [key]: _, ...rest } = read()
          write(rest)
        },
      })
    })
}
