import { spawn } from "node:child_process"

export interface Finished {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the program could not start, or when the time ran out. */
  readonly failure?: string
}

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
    const child = spawn(bin, [...args], {
      env: options.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    const kill = () => child.kill()
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
    child.on("close", (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", kill)
      resolve({ code, stdout, stderr, ...(failure ? { failure } : {}) })
    })
  })
