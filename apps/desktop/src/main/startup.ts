import type { MessageKey } from "@robot/shared"
import { fileState, NewerDatabaseError } from "./services/Database.ts"

/** What the error dialog at the start says: two catalogue keys and the values for the text. */
export interface StartProblem {
  readonly title: MessageKey
  readonly message: MessageKey
  readonly params: { readonly path: string; readonly detail: string }
}

const detailOf = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error)
  return text.split("\n")[0]?.slice(0, 200) ?? ""
}

/**
 * Tells the user why the app cannot start with its data file. A file from a newer version is never
 * opened and never erased. Any other failure to open the file (the file is damaged, or the account
 * may not read or write it or its folder) gets the second text. The app shows the text in a dialog
 * and quits, so it never stays alive with no window.
 */
export const describeStartFailure = (file: string, error: unknown): StartProblem => {
  const params = { path: file, detail: detailOf(error) }
  let newer = error instanceof NewerDatabaseError
  if (!newer) {
    try {
      newer = fileState(file) === "newer"
    } catch {
      // A file that cannot be read has no readable version. The other text covers it.
    }
  }
  return newer
    ? { title: "error.database_newer.title", message: "error.database_newer", params }
    : { title: "error.database_failed.title", message: "error.database_failed", params }
}
