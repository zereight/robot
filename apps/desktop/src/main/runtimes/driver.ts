import type { RuntimeKind, RuntimeLimit } from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"
import {
  claudeLogin,
  claudeProbe,
  claudeSignIn,
  claudeSignOut,
  claudeUsage,
  runClaude,
} from "./claude.ts"
import { codexLogin, codexProbe, codexSignIn, runCodex } from "./codex.ts"
import { cursorLogin, cursorProbe, runCursor } from "./cursor.ts"
import { MUSE_SIGN_IN_HOSTS, museLogin, museProbe, museSignIn, runMuse } from "./muse.ts"
import { opencodeLogin, opencodeProbe, runOpencode } from "./opencode.ts"
import { piLogin, piProbe, runPi } from "./pi.ts"
import type { Finished } from "./proc.ts"
import type { VersionProbe } from "./readiness.ts"
import type { Login, RuntimeRun } from "./types.ts"

export interface SignInPrompt {
  readonly url: string | null
  readonly code: string | null
}

/** What the app does with one kind of program. */
export interface Driver {
  /**
   * Asks the program for its version, once, with no model turn. The answer says why a program
   * fails: it does not start, does not answer, or gives text that the app cannot read.
   */
  probe(bin: string): Promise<VersionProbe>
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

export const drivers: Record<RuntimeKind, Driver> = {
  claude_code: {
    probe: claudeProbe,
    login: claudeLogin,
    usage: claudeUsage,
    signIn: (bin, signal, _onPrompt, dir) => claudeSignIn(bin, signal, dir),
    signOut: claudeSignOut,
    run: runClaude,
  },
  codex: {
    probe: codexProbe,
    login: codexLogin,
    signIn: (bin, signal) => codexSignIn(bin, signal),
    run: runCodex,
  },
  muse: {
    probe: museProbe,
    login: museLogin,
    signIn: museSignIn,
    signInHosts: MUSE_SIGN_IN_HOSTS,
    run: runMuse,
  },
  pi: { probe: piProbe, login: piLogin, run: runPi },
  opencode: { probe: opencodeProbe, login: opencodeLogin, run: runOpencode },
  cursor: { probe: cursorProbe, login: cursorLogin, run: runCursor },
}
