import { insideWorkspace } from "./tools.ts"

// File claims in shared folders (spec 025). This file holds the pure rules: when two folders are a
// shared folder, the words of a refusal, and the shared folder note. The main process holds the
// claims, and the window shows them.

/** A task holds at most this many claims (spec 025, "Rules"). */
export const CLAIMS_MAX = 1000
/** The shared folder note lists at most this many paths, then "and N more" (spec 025). */
export const CLAIM_NOTE_PATHS = 50
/** The first words of a prompt that a refusal names. */
export const PROMPT_WORDS = 8
export const PROMPT_CHARS = 80

/** The reason of the refusal for claim 1001 (spec 025, "Rules"). */
export const CLAIM_LIMIT_TEXT = `This task changed ${CLAIMS_MAX} files. Finish it.`

/**
 * True when two folders are a shared folder: the same folder, or one inside the other (spec 025).
 * The caller passes real paths. `fold` makes the names case-insensitive, as the file system of the
 * folder compares them.
 */
export const sharesFolder = (a: string, b: string, fold: boolean): boolean => {
  const f = (x: string) => (fold ? x.toLowerCase() : x)
  return insideWorkspace(f(a), f(b)) || insideWorkspace(f(b), f(a))
}

/** Who holds a claim: the workflow, and the node of its task, as the refusal names them. */
export interface ClaimHolder {
  readonly workflow: string
  readonly nodeNumber: number | null
  readonly node: string | null
  /** The prompt of the node, or an empty text when the node is gone. */
  readonly prompt: string
}

/** The first words of a prompt, cut at 8 words or 80 characters, on one line. */
export const promptStart = (prompt: string): string => {
  const words = prompt.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ""
  const cut = words.slice(0, PROMPT_WORDS).join(" ")
  const short = cut.length > PROMPT_CHARS ? `${cut.slice(0, PROMPT_CHARS - 1)}…` : cut
  return words.length > PROMPT_WORDS && short === cut ? `${short}…` : short
}

/** The line of the tool card: "Refused: in use by <holder>" (spec 025, flow 3). */
export const refusedLine = (workflow: string): string => `Refused: in use by ${workflow}`

/**
 * What the node reads when a step is refused: the line of the card, then the name of the holder,
 * the name of its node and the first words of its prompt. The turn goes on (spec 025, flow 3).
 */
export const refusalText = (holder: ClaimHolder): string => {
  const node =
    holder.node === null
      ? ""
      : ` Node ${holder.nodeNumber ?? "?"}, "${holder.node}", of that workflow holds it.`
  const prompt = promptStart(holder.prompt)
  return [
    `${refusedLine(holder.workflow)}.${node}`,
    prompt === "" ? "" : ` Its prompt starts: "${prompt}".`,
    ' The file was not changed. Work on other files, or end the task with a last line that starts with "Blocked:" that names the file and the holder.',
  ].join("")
}

/** One claim of a task of another workflow, as the note lists it. */
export interface NoteClaim {
  readonly path: string
  readonly workflow: string
  readonly nodeNumber: number | null
  readonly node: string | null
}

/**
 * The shared folder note of a text node (spec 025, "Shared folder note"): the other workflows that
 * share the folder, the claims of their tasks now (newest first, at most 50 paths, then "and N
 * more"), and two rules. It is not words of the user and holds no message text (spec 007).
 */
export const sharedFolderNote = (input: {
  readonly others: readonly string[]
  /** Newest first. */
  readonly claims: readonly NoteClaim[]
}): string => {
  const shown = input.claims.slice(0, CLAIM_NOTE_PATHS)
  const more = input.claims.length - shown.length
  return [
    `Shared folder. These workflows use your folder too: ${input.others.join(", ")}.`,
    shown.length === 0
      ? "No task of them holds a file now."
      : [
          "Files that their tasks hold now, newest first:",
          ...shown.map(
            (c) =>
              `- ${c.path} (${c.workflow}${c.node === null ? "" : `, node ${c.nodeNumber ?? "?"} "${c.node}"`})`,
          ),
          ...(more > 0 ? [`and ${more} more`] : []),
        ].join("\n"),
    "- Do not change a file that another workflow holds. Do not change it with a shell command either.",
    '- If the work cannot go on without such a file, end the task with a last line that starts with "Blocked:" that names the file and the holder.',
  ].join("\n")
}
