import { homedir } from "node:os"
import { join } from "node:path"

export interface Config {
  teamsUrl: string
  profileDir: string
  /** Installed browser. "chrome" or "msedge". No browser download is needed. */
  browserChannel: "chrome" | "msedge"
  marker: string
  pollMs: number
  chunkMax: number
  /** Send only when the open chat title contains this text. Empty means: never send. */
  expectTitle: string
}

function int(name: string, fallback: number, min: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`)
  return n
}

export function loadConfig(): Config {
  const channel = process.env.BROWSER_CHANNEL ?? "chrome"
  if (channel !== "chrome" && channel !== "msedge") {
    throw new Error('BROWSER_CHANNEL must be "chrome" or "msedge"')
  }
  return {
    teamsUrl: process.env.TEAMS_URL ?? "https://teams.cloud.microsoft/",
    profileDir: process.env.PROFILE_DIR ?? join(homedir(), ".teams-bridge", "profile"),
    browserChannel: channel,
    marker: process.env.MARKER ?? "[ROBot]",
    pollMs: int("POLL_MS", 3000, 500),
    chunkMax: int("CHUNK_MAX", 4000, 100),
    expectTitle: process.env.EXPECT_TITLE ?? "",
  }
}
