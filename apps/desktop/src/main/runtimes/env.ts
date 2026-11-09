import { delimiter } from "node:path"
import type { RuntimeKind } from "@robot/shared"
import { scrubGitEnv } from "../services/GitWorktrees.ts"

/**
 * Variables that make a vendor program use an API key, a gateway or a cloud account instead of
 * the subscription. The app removes them, so that a turn is billed to the subscription.
 */
const STRIPPED = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "META_API_KEY",
])

/** Folders where users keep tools. An app started from the desktop has a short PATH. */
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin"]

/**
 * The environment for a vendor program. pi and opencode are the exceptions: they serve the models
 * that the user set up in them, with keys from the environment among them, so their environment
 * is left alone. The git variables go for every kind, so a `git` of the program cannot reach
 * another repository through an inherited `GIT_DIR` or `GIT_INDEX_FILE`.
 */
export const runtimeEnv = (
  base: NodeJS.ProcessEnv = process.env,
  home = base.HOME ?? "",
  kind?: RuntimeKind,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base))
    if (kind === "pi" || kind === "opencode" || !STRIPPED.has(key)) env[key] = value
  // The launcher of Muse Code updates itself in the background. Not while ROBot uses it.
  if (kind === "muse") env.MUSE_NO_AUTO_UPDATE = "1"
  // The same for opencode: it does not update itself while ROBot uses it.
  if (kind === "opencode") env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  if (process.platform !== "win32") {
    const have = (env.PATH ?? "").split(delimiter)
    const extra = [...EXTRA_PATH, ...(home ? [`${home}/.local/bin`] : [])].filter(
      (dir) => !have.includes(dir),
    )
    env.PATH = [...have.filter(Boolean), ...extra].join(delimiter)
  }
  return scrubGitEnv(env)
}
