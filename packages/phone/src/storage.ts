/**
 * Where the phone keeps its files. The app gives the folder of its documents; the tests give a
 * map in memory. A path is relative, with `/` between the names.
 */
export interface PhoneStorage {
  /** The text of a file, or null when there is none. */
  read(path: string): Promise<string | null>
  /** Writes the whole file. */
  write(path: string, text: string): Promise<void>
  /** Removes a file, or a folder with all that is in it. Nothing happens when it is not there. */
  remove(path: string): Promise<void>
}

export class MemoryStorage implements PhoneStorage {
  readonly files = new Map<string, string>()

  async read(path: string) {
    return this.files.get(path) ?? null
  }

  async write(path: string, text: string) {
    this.files.set(path, text)
  }

  async remove(path: string) {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key)
    }
  }
}

/** Reads a JSON file. A file that is not there, or that does not read, gives `fallback`. */
export const readJson = async <T>(storage: PhoneStorage, path: string, fallback: T): Promise<T> => {
  try {
    const text = await storage.read(path)
    return text === null ? fallback : (JSON.parse(text) as T)
  } catch {
    return fallback
  }
}
