import type { RuntimeKind, RuntimeLimit } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import {
  claudeLogin,
  claudeSignIn,
  claudeSignOut,
  claudeUsage,
  claudeVersion,
  parseVersion,
  runClaude,
} from "./claude.ts"
import { codexLogin, codexSignIn, runCodex } from "./codex.ts"
import { runtimeEnv } from "./env.ts"
import { MUSE_SIGN_IN_HOSTS, museLogin, museSignIn, museVersion, runMuse } from "./muse.ts"
import { piLogin, piVersion, runPi } from "./pi.ts"
import { execute, type Finished } from "./proc.ts"
import type { Login, RuntimeRun } from "./types.ts"

export interface SignInPrompt {
  readonly url: string | null
  readonly code: string | null
}

/** What the app does with one kind of program. */
export interface Driver {
  version(bin: string): Promise<string | null>
  /**
   * Who is signed in. `dir` is the folder of a separate sign-in. Only a driver that has
   * `signOut` takes it; the others look at the one sign-in that the program has.
   */
  login(bin: string, dir?: string): Promise<Login>
  /**
   * The usage windows of the plan, asked without a turn. Null when the program does not tell
   * them. Absent when the program tells them in `login`, or not at all.
   */
  usage?(bin: string, dir?: string): Promise<readonly RuntimeLimit[] | null>
  /** Starts the sign-in of the program. Absent when the user signs in inside the program. */
  signIn?(
    bin: string,
    signal: AbortSignal,
    onPrompt: (prompt: SignInPrompt) => void,
    dir?: string,
  ): Promise<Finished>
  /**
   * Signs out of a separate sign-in. Present only for a program that can have one: the program
   * then keeps that sign-in in the folder `dir`.
   */
  signOut?(bin: string, dir: string): Promise<Finished>
  /** Hosts whose pages may be opened for the sign-in. The program that opens its own page needs none. */
  readonly signInHosts?: readonly string[]
  run(run: RuntimeRun): AsyncGenerator<AgentEvent>
}

const codexVersion = async (bin: string) => {
  const done = await execute(bin, ["--version"], { env: runtimeEnv(), timeoutMs: 15_000 })
  return done.code === 0 ? parseVersion(done.stdout) : null
}

export const drivers: Record<RuntimeKind, Driver> = {
  claude_code: {
    version: claudeVersion,
    login: claudeLogin,
    usage: claudeUsage,
    signIn: (bin, signal, _onPrompt, dir) => claudeSignIn(bin, signal, dir),
    signOut: claudeSignOut,
    run: runClaude,
  },
  codex: {
    version: codexVersion,
    login: codexLogin,
    signIn: (bin, signal) => codexSignIn(bin, signal),
    run: runCodex,
  },
  muse: {
    version: museVersion,
    login: museLogin,
    signIn: museSignIn,
    signInHosts: MUSE_SIGN_IN_HOSTS,
    run: runMuse,
  },
  pi: { version: piVersion, login: piLogin, run: runPi },
}
