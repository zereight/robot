import { existsSync, mkdirSync } from "node:fs"
import { makeOwnedFolder } from "../stale-temp.ts"

let dir: string | null = null

/**
 * The folder where a vendor program runs for the chat. It is empty and private (mode 0700), under
 * the temporary folder of the system, and never inside the data folder (which holds the database
 * and the sign-ins) or a folder of a workflow. It is made again when something removed it.
 */
export const chatDir = (): string => {
  if (dir !== null && existsSync(dir)) return dir
  const made = makeOwnedFolder("robot-chat-")
  // `mkdtemp` makes the folder with mode 0700; this keeps it so on any system.
  mkdirSync(made, { recursive: true, mode: 0o700 })
  dir = made
  return made
}
