import { spawn } from "node:child_process"
import { delimiter } from "node:path"

const START = "__ROBOT_PATH_START__"
const END = "__ROBOT_PATH_END__"

/** The text between the two marks. A start file of the shell may print other text around it. */
export const parseLoginPath = (output: string): string | null => {
  const from = output.lastIndexOf(START)
  if (from < 0) return null
  const to = output.indexOf(END, from + START.length)
  if (to < 0) return null
  return output.slice(from + START.length, to) || null
}

/** The folders of the login PATH come first. Folders only the app has follow them, once each. */
export const mergePath = (current: string | undefined, login: string): string => {
  const seen = new Set<string>()
  const dirs = [...login.split(delimiter), ...(current ?? "").split(delimiter)].filter((dir) => {
    if (!dir || seen.has(dir)) return false
    seen.add(dir)
    return true
  })
  return dirs.join(delimiter)
}

/**
 * Asks the login shell of the user for its PATH. Null when the shell fails, does not answer in
 * time, or prints no PATH.
 */
export const readLoginPath = (
  options: { shell?: string; timeoutMs?: number } = {},
): Promise<string | null> =>
  new Promise((resolve) => {
    const shell =
      options.shell ?? process.env.SHELL ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
    let output = ""
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    try {
      const child = spawn(shell, ["-ilc", `printf '%s%s%s' ${START} "$PATH" ${END}`], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      timer = setTimeout(() => {
        child.kill("SIGKILL")
        finish(null)
      }, options.timeoutMs ?? 5_000)
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8")
      })
      child.on("error", () => finish(null))
      child.on("close", () => finish(parseLoginPath(output)))
    } catch {
      finish(null)
    }
  })

/**
 * An app that starts from the desktop has a short PATH, without the folders that the shell of the
 * user adds (for example the one of nvm). Programs such as pi are not there, and pi cannot find
 * node. This adds the PATH of the login shell to the one of the app. A failure changes nothing.
 */
export const importLoginPath = async (env: NodeJS.ProcessEnv = process.env): Promise<void> => {
  if (process.platform === "win32") return
  const login = await readLoginPath()
  if (login) env.PATH = mergePath(env.PATH, login)
}
