import { killProgram, spawnProgram } from "./programs.ts"

export interface Finished {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the program could not start, or when the time ran out. */
  readonly failure?: string
}

/** How long a program that was told to end may take to close, before the caller goes on. */
const KILL_GRACE_MS = 1000

/** Runs a program to its end and collects its output. It never throws. */
export const execute = (
  bin: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv
    cwd?: string
    timeoutMs: number
    signal?: AbortSignal
    /** Called with each piece of output as it arrives. */
    onData?: (text: string) => void
  },
): Promise<Finished> =>
  new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let failure: string | undefined
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const child = spawnProgram(bin, [...args], {
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      options.signal?.removeEventListener("abort", kill)
      resolve({ code, stdout, stderr, ...(failure ? { failure } : {}) })
    }
    // A program that is killed can leave a child of its own that holds the pipes open, and then
    // the program never reports that it closed. The caller must not wait for that (spec 006).
    const kill = () => {
      killProgram(child)
      grace ??= setTimeout(() => finish(null), KILL_GRACE_MS)
    }
    const timer = setTimeout(() => {
      failure = "timeout"
      kill()
    }, options.timeoutMs)
    options.signal?.addEventListener("abort", kill, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 200_000) stdout += chunk.toString()
      options.onData?.(chunk.toString())
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString()
      options.onData?.(chunk.toString())
    })
    child.on("error", (error) => {
      failure = error.message
    })
    child.on("close", (code) => finish(code))
  })
