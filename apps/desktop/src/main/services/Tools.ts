import { spawn } from "node:child_process"
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import {
  type ActionDecider,
  type ApprovalAnswer,
  type GuardedStep,
  guardDecision,
  holdOutside,
  hostOf,
  insideWorkspace,
  KNOWLEDGE_FOLDER,
  KNOWLEDGE_SOURCE_BYTES,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_TURN_CHANGES_MAX,
  type KnowledgeNote,
  MEMORY_TEXT_MAX,
  type MemoryNote,
  needsApproval,
  type PermissionLevel,
  riskyReason,
  type ToolAsk,
  type TurnMark,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import type { ToolEvent, ToolOutcome } from "../providers/agent.ts"
import type { ToolCall, ToolDef } from "../providers/chat.ts"
import { BRIDGE_TOOL_NAMES, type BridgeHandler } from "../runtimes/bridge.ts"
import type { ApprovalRequest } from "../runtimes/types.ts"
import { ActionLog } from "./ActionLog.ts"
import { CurrentActor } from "./actor.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Knowledge, type KnowledgePlan } from "./Knowledge.ts"
import { Memory, type MemoryOrigin } from "./Memory.ts"
import { type PageBounds, Platform } from "./Platform.ts"

export interface ToolContext {
  readonly agentId: string
  readonly workspace: string
  readonly permission: PermissionLevel
  readonly signal: AbortSignal
  /** Shows a card that waits for the user (`ask`), or hides it again (`null`). */
  readonly onWaiting: (callId: string, ask: ToolAsk | null) => void
  /** Records what the memory tool did, so its line in the chat can offer undo or a link. */
  readonly onMemory: (callId: string, note: MemoryNote) => void
  /** Where the turn runs: the chat that a suggestion for memory names as its origin. */
  readonly origin?: MemoryOrigin
  /** Records that a linked device answered an approval, so its card can say who. */
  readonly onDecision?: (callId: string, answer: "allow" | "deny", by: string) => void
  /** Records what a knowledge call read or changed, so its card can show it and offer undo. */
  readonly onKnowledge: (callId: string, note: KnowledgeNote) => void
  /** The article changes that this turn made so far. A turn makes at most 5. */
  readonly knowledgeChanges: { count: number }
  /**
   * Who started the turn, and the first source of outside content in it (spec 007, "Outside
   * content"). A tool that gives outside content to the agent marks it with `holdOutside`.
   */
  readonly turn: TurnMark
  /** The task of the turn, for the action log. */
  readonly taskId: string | null
}

/**
 * A guarded step (spec 007, "Outside content"): its kind, the text that the card and the log
 * show, and the work. `usual` is the way the step goes in a turn with no outside content; it
 * resolves with who decided, or throws to refuse. With no `usual`, the step runs at once.
 * `denied` is true when a Deny rule matches the step.
 */
export interface GuardedRequest<A> {
  readonly step: GuardedStep
  readonly target: string
  readonly work: () => Promise<A>
  readonly usual?: () => Promise<ActionDecider>
  readonly denied?: boolean
}

export interface ToolsService {
  /** The tools that an agent may call. Memory and knowledge tools are left out when they are off. */
  defs(options: { memory: boolean; knowledge: boolean }): readonly ToolDef[]
  execute(context: ToolContext, call: ToolCall): Promise<ToolOutcome>
  /**
   * Asks about a step that a vendor program wants to take, by the permission level and the risk.
   * Resolves true to go on and false when the user denies. Rejects when the turn stops.
   */
  approval(context: ToolContext, request: ApprovalRequest): Promise<boolean>
  /**
   * The tools of the app that an agent runtime may call: the browser. The runtime has no tool of
   * its own for them, so it calls the app (see bridge.ts). Each call runs like the call of an API
   * agent, at the permission level of the agent. `show` puts the card of the call in the reply.
   */
  bridge(context: ToolContext, show: (event: ToolEvent) => void): BridgeHandler
  /**
   * Runs a guarded step of a turn. It asks with a card that has Allow once and Deny only when
   * the turn holds outside content, refuses it on a Deny rule, and writes the action log entry.
   * A tool of a later slice calls this for its own guarded step. Rejects with the refusal, which
   * `execute` gives to the agent as a failed step.
   */
  guarded<A>(context: ToolContext, callId: string, request: GuardedRequest<A>): Promise<A>
  /** Answers a card that waits. Unknown cards are ignored. */
  respond(agentId: string, callId: string, answer: string): Effect.Effect<void>
  /** True while a task of this computer waits for the answer to this card. */
  isWaiting(agentId: string, callId: string): boolean
  /** Whether the browser of an agent is open, and whether the user holds the controls. */
  browserState(agentId: string): { open: boolean; control: boolean }
  /** The user takes the controls (`true`) or gives them back (`false`). */
  setBrowserControl(agentId: string, control: boolean): void
  closeBrowser(agentId: string): void
  /**
   * Where the browser of an agent shows in the app window. `undefined` hides it. The chat screen
   * calls this each time its place changes.
   */
  placeBrowser(agentId: string, bounds: PageBounds | undefined): void
}

const READ_MAX = 100_000
const OUTPUT_MAX = 20_000
const COMMAND_TIMEOUT_MS = 120_000
const FETCH_TIMEOUT_MS = 20_000
const FETCH_MAX = 50_000
const LIST_MAX = 200
const SEARCH_MAX = 50
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build"])

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
})
const str = (description: string) => ({ type: "string", description })

const DEFS: Record<string, ToolDef> = {
  list_files: {
    name: "list_files",
    description: "List the files and folders in a folder of your workspace.",
    schema: object({ path: str("Folder, relative to the workspace. Default: the workspace.") }, []),
  },
  read_file: {
    name: "read_file",
    description: "Read a text file.",
    schema: object({ path: str("File path, relative to the workspace.") }, ["path"]),
  },
  write_file: {
    name: "write_file",
    description: "Write a text file. Folders are made when needed. An existing file is replaced.",
    schema: object({ path: str("File path."), content: str("The whole new content.") }, [
      "path",
      "content",
    ]),
  },
  search_files: {
    name: "search_files",
    description: "Search the text files of your workspace for a text. Returns matching lines.",
    schema: object({ query: str("The text to look for.") }, ["query"]),
  },
  run_command: {
    name: "run_command",
    description: "Run a shell command in your workspace and return its output.",
    schema: object({ command: str("The command line.") }, ["command"]),
  },
  fetch_url: {
    name: "fetch_url",
    description: "Fetch a web page or file with GET and return its text.",
    schema: object({ url: str("An http or https address.") }, ["url"]),
  },
  ask_user: {
    name: "ask_user",
    description: "Ask the user a question and wait for the answer.",
    schema: {
      type: "object",
      properties: {
        question: str("The question."),
        choices: { type: "array", items: { type: "string" }, description: "Optional answers." },
      },
      required: ["question"],
    },
  },
  browser_open: {
    name: "browser_open",
    description:
      "Open a web page in a browser that the user can watch in the app window. Logins stay between runs.",
    schema: object({ url: str("An http or https address.") }, ["url"]),
  },
  browser_read: {
    name: "browser_read",
    description: "Read the text of the page that is open in the browser.",
    schema: object({}, []),
  },
  browser_click: {
    name: "browser_click",
    description: "Click the element that matches a CSS selector on the open page.",
    schema: object({ selector: str("A CSS selector.") }, ["selector"]),
  },
  browser_type: {
    name: "browser_type",
    description: "Type text into the field that matches a CSS selector on the open page.",
    schema: object({ selector: str("A CSS selector."), text: str("The text.") }, [
      "selector",
      "text",
    ]),
  },
  browser_close: {
    name: "browser_close",
    description: "Close the browser.",
    schema: object({}, []),
  },
  save_memory: {
    name: "save_memory",
    description:
      "Save one short, lasting fact (a preference, a name, a decision) to your memory. Use at most 500 characters. Never save a password, a key or a token. The user may decide first whether the fact is kept.",
    schema: object({ text: str("The fact, in one sentence.") }, ["text"]),
  },
  read_article: {
    name: "read_article",
    description: "Read one article of your knowledge by its title.",
    schema: object({ title: str("The title of the article.") }, ["title"]),
  },
  write_article: {
    name: "write_article",
    description:
      "Add an article to your knowledge, or replace the article that has this title. Send the whole body. Link to other articles with [[Title]].",
    schema: {
      type: "object",
      properties: {
        title: str("The title, 1 to 80 characters. It is unique, ignoring case."),
        summary: str("One line, up to 160 characters."),
        body: str("The article in Markdown, up to 20000 characters."),
        links: {
          type: "array",
          items: { type: "string" },
          description: "Titles of other articles to link. They are added to the end of the body.",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Names of sources (from add_source) that the article uses.",
        },
      },
      required: ["title", "body"],
    },
  },
  delete_article: {
    name: "delete_article",
    description: "Delete an article of your knowledge. The user can undo this.",
    schema: object({ title: str("The title of the article.") }, ["title"]),
  },
  add_source: {
    name: "add_source",
    description:
      "Keep a copy of a file or web page as a source for articles. Give a path or an address. A source cannot be changed after.",
    schema: object(
      {
        path: str("A file in your workspace, relative to it."),
        url: str("An http or https address to fetch."),
        name: str("A name for the copy. Optional."),
      },
      [],
    ),
  },
}

const KNOWLEDGE_TOOLS = new Set(["read_article", "write_article", "delete_article", "add_source"])

/** What the model reads when a knowledge call fails. The card shows its own translated text. */
const KNOWLEDGE_MESSAGES: Record<string, string> = {
  knowledge_title_invalid: "The title must have 1 to 80 characters.",
  knowledge_summary_long: "The summary can have 160 characters at most.",
  knowledge_body_long: "The body can have 20000 characters at most.",
  knowledge_title_taken: "Another article has this title.",
  knowledge_full: "The knowledge holds 500 articles. It cannot take more. Tell the user.",
  knowledge_secret:
    "The text equals or looks like a key or a token. It was not saved. Do not put keys in articles or sources.",
  knowledge_not_found: "There is no article with this title.",
  knowledge_turn_limit: "You made 5 article changes in this turn. Wait for the next turn.",
  knowledge_source_missing: "A named source does not exist. Add it with add_source first.",
  knowledge_source_invalid: "Give the path of a file in your workspace, or an http address.",
  knowledge_source_big: "The source is larger than 20 MB.",
  knowledge_changed: "The article changed while you worked. Read it again.",
  knowledge_off: "Knowledge is off for this agent.",
  knowledge_denied: "The user denied this change.",
  knowledge_undone: "This change was undone already.",
  knowledge_fetch_failed: "The page could not be fetched.",
  knowledge_io: "The Knowledge folder could not be read or written.",
}

const parseArgs = (call: ToolCall): Record<string, unknown> => {
  try {
    const value = JSON.parse(call.input || "{}")
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
const text = (args: Record<string, unknown>, key: string) =>
  typeof args[key] === "string" ? (args[key] as string) : ""

const cut = (value: string, max: number) =>
  value.length > max
    ? `${value.slice(0, max)}\n[cut: ${value.length - max} more characters]`
    : value

class Denied extends Error {}
/** A guarded step that a Deny rule or the level "Read only" refuses. The agent reads the message. */
class Refused extends Error {}

export class Tools extends Context.Service<Tools, ToolsService>()("robot/main/Tools") {
  static readonly layer = Layer.effect(
    Tools,
    Effect.gen(function* () {
      const db = yield* Database
      const memory = yield* Memory
      const actionLog = yield* ActionLog
      const knowledge = yield* Knowledge
      const platform = yield* Platform
      const bus = yield* EventBus
      const control = new Set<string>()
      const wired = new Set<string>()
      const browserChanged = (agentId: string) => bus.emit("browser.changed", { agentId })
      const pageOf = (agentId: string) => {
        const page = platform.browser(agentId)
        if (!wired.has(agentId)) {
          wired.add(agentId)
          page.onClosed(() => {
            control.delete(agentId)
            page.allowUserInput(false)
            browserChanged(agentId)
          })
        }
        return page
      }
      /** The card that waits, by agent and call. The answer says which device gave it, if any. */
      const waiting = new Map<string, (answer: string, by: string | null) => void>()

      const allowed = (agentId: string, key: string) =>
        db.get("SELECT 1 AS x FROM agent_allow WHERE agent_id = ? AND key = ?", agentId, key) !==
        undefined
      const allow = (agentId: string, key: string) =>
        db.run("INSERT OR IGNORE INTO agent_allow (agent_id, key) VALUES (?, ?)", agentId, key)

      /** Waits for the user to answer a card. Rejects when the turn stops. */
      const wait = (ctx: ToolContext, callId: string, ask: ToolAsk) =>
        new Promise<{ answer: string; by: string | null }>((resolveAnswer, reject) => {
          const id = `${ctx.agentId}:${callId}`
          const stop = () => {
            waiting.delete(id)
            reject(new Error("stopped"))
          }
          if (ctx.signal.aborted) return stop()
          ctx.signal.addEventListener("abort", stop, { once: true })
          waiting.set(id, (answer, by) => {
            waiting.delete(id)
            ctx.signal.removeEventListener("abort", stop)
            resolveAnswer({ answer, by })
          })
          ctx.onWaiting(callId, { ...ask, askedAt: Date.now() })
        }).finally(() => ctx.onWaiting(callId, null))

      /** Asks for approval when the level and the risk need it. Throws `Denied` on a no. */
      const approve = async (
        ctx: ToolContext,
        call: ToolCall,
        risky: boolean,
        key: string,
        summary: string,
      ) => {
        if (!needsApproval(ctx.permission, risky) || allowed(ctx.agentId, key)) return
        const reply = await wait(ctx, call.id, { kind: "approval", summary })
        const answer = reply.answer as ApprovalAnswer
        if (reply.by) ctx.onDecision?.(call.id, answer === "deny" ? "deny" : "allow", reply.by)
        // A linked device cannot change what an agent may always do (spec 012): its "always" is
        // one "allow", and the next step asks again.
        if (answer === "always") {
          if (!reply.by) allow(ctx.agentId, key)
        } else if (answer !== "allow") throw new Denied()
      }

      /** See `ToolsService.guarded`. */
      const guarded = async <A>(
        ctx: ToolContext,
        callId: string,
        request: GuardedRequest<A>,
      ): Promise<A> => {
        // The source as it is now: a step that gives outside content later does not change it.
        const outside = ctx.turn.source
        const log = (decidedBy: ActionDecider, result: "ran" | "failed" | "refused" | "stopped") =>
          actionLog.add({
            agentId: ctx.agentId,
            kind: request.step,
            target: request.target,
            decidedBy,
            result,
            taskId: ctx.taskId,
            outside,
          })
        const verdict = guardDecision({
          step: request.step,
          level: ctx.permission,
          outside: outside !== null,
          starter: ctx.turn.starter,
          denied: request.denied === true,
        })
        if (verdict === "refuse_rule") {
          log("deny_rule", "refused")
          throw new Refused("Denied by a rule.")
        }
        if (verdict === "refuse_read_only") {
          log("level", "refused")
          throw new Refused("Refused: read only.")
        }
        let decidedBy: ActionDecider = "level"
        if (verdict === "ask") {
          let reply: { answer: string; by: string | null }
          try {
            reply = await wait(ctx, callId, {
              kind: "approval",
              summary: request.target,
              once: true,
              ...(outside ? { outside } : {}),
            })
          } catch (error) {
            log("level", "stopped")
            throw error
          }
          const yes = reply.answer === "allow" || reply.answer === "always"
          if (reply.by) ctx.onDecision?.(callId, yes ? "allow" : "deny", reply.by)
          decidedBy = "user"
          if (!yes) {
            log("user", "refused")
            throw new Denied()
          }
        } else if (verdict === "usual" && request.usual) {
          try {
            decidedBy = await request.usual()
          } catch (error) {
            log(
              error instanceof Denied ? "user" : "level",
              ctx.signal.aborted ? "stopped" : "refused",
            )
            throw error
          }
        }
        try {
          const value = await request.work()
          log(decidedBy, "ran")
          return value
        } catch (error) {
          log(decidedBy, ctx.signal.aborted ? "stopped" : "failed")
          throw error
        }
      }

      /** The real path of a file or of its nearest folder that exists, so symlinks count. */
      const realOf = (path: string): string => {
        try {
          return realpathSync(path)
        } catch {
          const parent = dirname(path)
          return parent === path ? path : join(realOf(parent), basename(path))
        }
      }

      /** A path of the model, resolved from the workspace. Symlinks count at their target. */
      const place = (ctx: ToolContext, path: string) => {
        const full = resolve(ctx.workspace, path || ".")
        const root = realOf(ctx.workspace)
        const inside = insideWorkspace(realOf(full), root)
        return { full, inside }
      }

      /**
       * The file tools do not work on a source, and do not work in the Knowledge folder while
       * knowledge is on. The agent gets a plain error and uses the article tools. A path is
       * compared in lower case, because a disk can ignore case.
       */
      const knowledgeBlock = (ctx: ToolContext, full: string): string | null => {
        const root = realOf(join(ctx.workspace, KNOWLEDGE_FOLDER)).toLowerCase()
        const target = realOf(full).toLowerCase()
        if (insideWorkspace(target, join(root, KNOWLEDGE_SOURCES.toLowerCase())))
          return "A source cannot be read or changed with the file tools."
        if (insideWorkspace(target, root) && knowledge.enabled(ctx.agentId))
          return "Use read_article, write_article and delete_article for the Knowledge folder."
        return null
      }

      const runCommand = (ctx: ToolContext, command: string) =>
        new Promise<ToolOutcome>((done) => {
          const child = spawn(command, {
            cwd: ctx.workspace,
            shell: true,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
          })
          let out = ""
          const take = (chunk: Buffer) => {
            if (out.length < OUTPUT_MAX * 2) out += chunk.toString()
          }
          child.stdout.on("data", take)
          child.stderr.on("data", take)
          const kill = () => {
            try {
              if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
              else child.kill("SIGKILL")
            } catch {}
          }
          const timer = setTimeout(kill, COMMAND_TIMEOUT_MS)
          ctx.signal.addEventListener("abort", kill, { once: true })
          child.on("error", (e) => {
            clearTimeout(timer)
            done({ output: String(e.message), failed: true })
          })
          child.on("close", (code, signal) => {
            clearTimeout(timer)
            ctx.signal.removeEventListener("abort", kill)
            const body = cut(out, OUTPUT_MAX)
            done({
              output: signal ? `${body}\n[ended by ${signal}]` : `${body}\n[exit code ${code}]`,
              failed: code !== 0,
            })
          })
        })

      const searchFiles = (root: string, query: string, skip: (dir: string) => boolean) => {
        const hits: string[] = []
        const q = query.toLocaleLowerCase()
        const walk = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (hits.length >= SEARCH_MAX) return
            const path = join(dir, entry.name)
            if (entry.isDirectory()) {
              if (!SKIP_DIRS.has(entry.name) && !skip(path)) walk(path)
            } else if (entry.isFile() && statSync(path).size < 1_000_000) {
              const lines = readFileSync(path, "utf8").split("\n")
              for (const [i, line] of lines.entries()) {
                if (line.toLocaleLowerCase().includes(q) && !line.includes("\0"))
                  hits.push(`${relative(root, path)}:${i + 1}: ${line.trim().slice(0, 200)}`)
                if (hits.length >= SEARCH_MAX) return
              }
            }
          }
        }
        walk(root)
        return hits
      }

      /** Fetches a page with GET. A page of HTML becomes plain text. */
      const fetchPage = async (ctx: ToolContext, url: string) => {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        const response = await fetch(url, { signal, redirect: "follow" })
        let body = await response.text()
        if ((response.headers.get("content-type") ?? "").includes("html"))
          body = body
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        // The text of the page reaches the agent: the turn holds outside content from now on.
        holdOutside(ctx.turn, { kind: "page", host: hostOf(response.url || url) })
        return { status: response.status, ok: response.ok, body }
      }

      const fetchUrl = async (ctx: ToolContext, url: string): Promise<ToolOutcome> => {
        if (!/^https?:\/\//i.test(url))
          return { output: "Only http and https addresses work.", failed: true }
        const page = await fetchPage(ctx, url)
        return { output: cut(`[status ${page.status}]\n${page.body}`, FETCH_MAX), failed: !page.ok }
      }

      /** Waits while the user holds the controls of the browser. Stop ends the wait. */
      const whileUserHolds = async (ctx: ToolContext) => {
        while (control.has(ctx.agentId) && !ctx.signal.aborted)
          await new Promise((r) => setTimeout(r, 200))
      }

      const browserTool = async (ctx: ToolContext, call: ToolCall): Promise<ToolOutcome> => {
        const args = parseArgs(call)
        const page = pageOf(ctx.agentId)
        // Stop closes the window at once, even in the middle of a page load.
        const stop = () => page.close()
        ctx.signal.addEventListener("abort", stop, { once: true })
        try {
          if (call.name === "browser_close") {
            page.close()
            return { output: "Closed.", failed: false }
          }
          if (call.name === "browser_open") {
            const url = text(args, "url")
            if (!/^https?:\/\//i.test(url))
              return { output: "Only http and https addresses work.", failed: true }
            await approve(ctx, call, false, "browser_open", url)
            await whileUserHolds(ctx)
            const opened = await page.open(url)
            holdOutside(ctx.turn, { kind: "page", host: hostOf(opened.url || url) })
            browserChanged(ctx.agentId)
            return { output: `Opened ${opened.url}\nTitle: ${opened.title}`, failed: false }
          }
          await approve(ctx, call, false, "browser_act", `${call.name} ${call.input}`)
          await whileUserHolds(ctx)
          if (ctx.signal.aborted) throw new Error("stopped")
          if (call.name === "browser_read") {
            const read = await page.read()
            holdOutside(ctx.turn, { kind: "page", host: hostOf(read.url) })
            return { output: `${read.url}\nTitle: ${read.title}\n\n${read.text}`, failed: false }
          }
          if (call.name === "browser_click") await page.click(text(args, "selector"))
          else await page.type(text(args, "selector"), text(args, "text"))
          return { output: "Done.", failed: false }
        } finally {
          ctx.signal.removeEventListener("abort", stop)
        }
      }

      /** Runs an effect of the knowledge service. A failure comes back as the error itself. */
      const settle = async <A>(effect: Effect.Effect<A, AppError>): Promise<A> => {
        const exit = await Effect.runPromiseExit(effect)
        if (Exit.isSuccess(exit)) return exit.value
        throw Cause.squash(exit.cause)
      }

      /** A knowledge call failed: the card says why, and the model reads the reason. */
      const knowledgeFailure = (
        ctx: ToolContext,
        call: ToolCall,
        title: string,
        error: unknown,
      ): ToolOutcome => {
        // A stop ends the turn. It is not a failure of the call.
        if (ctx.signal.aborted) throw error
        const code =
          error instanceof Denied
            ? "knowledge_denied"
            : error instanceof AppError
              ? error.code
              : "knowledge_io"
        ctx.onKnowledge(call.id, { kind: "failed", title, code })
        const reason = KNOWLEDGE_MESSAGES[code] ?? KNOWLEDGE_MESSAGES.knowledge_io
        const detail = error instanceof AppError && error.detail ? ` (${error.detail})` : ""
        return { output: `Not done: ${reason}${detail}`, failed: true }
      }

      /**
       * The first save by the agent into a missing Knowledge folder of a chosen workspace asks
       * first, and the card names the folder. At "Full access" nothing asks.
       */
      const approveFirstSave = async (
        ctx: ToolContext,
        call: ToolCall,
        folder: { path: string; exists: boolean; chosen: boolean },
      ) => {
        if (folder.exists || !folder.chosen || ctx.permission === "full") return
        const reply = await wait(ctx, call.id, {
          kind: "approval",
          summary: folder.path,
          once: true,
        })
        if (reply.answer !== "allow") throw new Denied()
      }

      /** Asks the user before the change that the rules call for: a first save in a chosen workspace, an article the user edited last. */
      const approveKnowledge = async (ctx: ToolContext, call: ToolCall, plan: KnowledgePlan) => {
        await approveFirstSave(ctx, call, {
          path: plan.folder,
          exists: !plan.creates,
          chosen: plan.chosenWorkspace,
        })
        if (!plan.protected || ctx.permission === "full") return
        const reply = await wait(ctx, call.id, {
          kind: "article",
          title: plan.title,
          before: plan.compare.before,
          after: plan.compare.after,
        })
        if (reply.answer !== "allow" && reply.answer !== "always") throw new Denied()
      }

      const changeTool = async (
        ctx: ToolContext,
        call: ToolCall,
        args: Record<string, unknown>,
      ): Promise<ToolOutcome> => {
        const title = text(args, "title")
        try {
          if (ctx.knowledgeChanges.count >= KNOWLEDGE_TURN_CHANGES_MAX)
            throw new AppError({ code: "knowledge_turn_limit" })
          if (!knowledge.enabled(ctx.agentId)) throw new AppError({ code: "knowledge_off" })
          const strings = (key: string) =>
            Array.isArray(args[key])
              ? (args[key] as unknown[]).filter((x): x is string => typeof x === "string")
              : undefined
          const plan = await settle(
            call.name === "delete_article"
              ? knowledge.plan(ctx.agentId, { type: "delete", title })
              : knowledge.plan(ctx.agentId, {
                  type: "write",
                  title,
                  ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
                  ...(typeof args.body === "string" ? { body: args.body } : {}),
                  ...(strings("links") ? { links: strings("links") as string[] } : {}),
                  ...(strings("sources") ? { sources: strings("sources") as string[] } : {}),
                }),
          )
          await approveKnowledge(ctx, call, plan)
          const change = await settle(knowledge.apply(plan, "agent"))
          ctx.knowledgeChanges.count++
          ctx.onKnowledge(call.id, {
            kind: "write",
            title: plan.title,
            change: change.kind,
            changeId: change.id,
          })
          const done = change.kind === "delete" ? "Deleted" : "Saved"
          return { output: `${done} the article "${plan.title}".`, failed: false }
        } catch (error) {
          return knowledgeFailure(ctx, call, title, error)
        }
      }

      const readTool = async (
        ctx: ToolContext,
        call: ToolCall,
        args: Record<string, unknown>,
      ): Promise<ToolOutcome> => {
        const title = text(args, "title")
        try {
          if (!knowledge.enabled(ctx.agentId)) throw new AppError({ code: "knowledge_off" })
          const article = await settle(knowledge.find(ctx.agentId, title))
          ctx.onKnowledge(call.id, { kind: "read", title: article.title })
          const missing = article.links.filter((l) => l.file === null).map((l) => l.title)
          const lines = [
            `Title: ${article.title}`,
            `Summary: ${article.summary}`,
            `Last changed: ${new Date(article.updatedAt).toISOString()}`,
            `Sources: ${
              article.sources.map((s) => (s.exists ? s.name : `${s.name} (deleted)`)).join(", ") ||
              "none"
            }`,
            ...(missing.length > 0
              ? [`Links to articles that do not exist: ${missing.join(", ")}`]
              : []),
            "",
            article.body,
          ]
          return { output: lines.join("\n"), failed: false }
        } catch (error) {
          return knowledgeFailure(ctx, call, title, error)
        }
      }

      const sourceName = (url: string) => {
        try {
          const parsed = new URL(url)
          const path = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean).join("-")
          return `${parsed.hostname}${path ? `-${path}` : ""}.txt`
        } catch {
          return "page.txt"
        }
      }

      const sourceTool = async (
        ctx: ToolContext,
        call: ToolCall,
        args: Record<string, unknown>,
      ): Promise<ToolOutcome> => {
        const path = text(args, "path")
        const url = text(args, "url")
        const label = path || url
        try {
          if (!knowledge.enabled(ctx.agentId)) throw new AppError({ code: "knowledge_off" })
          if (Boolean(path) === Boolean(url))
            throw new AppError({ code: "knowledge_source_invalid" })
          let data: Uint8Array | string
          let name = text(args, "name")
          if (path) {
            const p = place(ctx, path)
            const knowledgeRoot = realOf(join(ctx.workspace, KNOWLEDGE_FOLDER))
            if (
              !p.inside ||
              insideWorkspace(realOf(p.full), join(knowledgeRoot, KNOWLEDGE_SOURCES))
            )
              throw new AppError({ code: "knowledge_source_invalid" })
            const info = statSync(p.full)
            if (!info.isFile()) throw new AppError({ code: "knowledge_source_invalid" })
            if (info.size > KNOWLEDGE_SOURCE_BYTES)
              throw new AppError({ code: "knowledge_source_big" })
            data = readFileSync(p.full)
            name = name || basename(p.full)
          } else {
            if (!/^https?:\/\//i.test(url)) throw new AppError({ code: "knowledge_source_invalid" })
            await approve(ctx, call, false, "fetch_url", url)
            const page = await fetchPage(ctx, url)
            if (!page.ok)
              throw new AppError({ code: "knowledge_fetch_failed", detail: `${page.status}` })
            data = `Fetched from ${url}\n\n${page.body}\n`
            name = name || sourceName(url)
          }
          // A source with a key is refused before anything is asked or written.
          await settle(knowledge.checkSource(data))
          // Keeping the first source makes the folder, which is a save.
          await approveFirstSave(ctx, call, await settle(knowledge.folder(ctx.agentId)))
          const saved = await settle(knowledge.addSource(ctx.agentId, { name, data }))
          ctx.onKnowledge(call.id, { kind: "source", name: saved.name })
          return {
            output: `Kept the source as "${saved.name}". Name it in the sources of the articles that use it.`,
            failed: false,
          }
        } catch (error) {
          return knowledgeFailure(ctx, call, label, error)
        }
      }

      /** The memory tool: saves at once or suggests, by the choice of the agent (spec 008). */
      const saveMemory = async (
        ctx: ToolContext,
        call: ToolCall,
        value: string,
      ): Promise<ToolOutcome> => {
        const plan = await Effect.runPromise(memory.plan(ctx.agentId, value))
        const make = () => Effect.runPromise(memory.save(ctx.agentId, value, ctx.origin))
        // A save at once is a guarded step (spec 007, "Outside content"): in a turn that holds
        // outside content it asks first, so a web page cannot put a lasting order into memory.
        // A proposal is not memory and needs no card, and a refused text asks nothing.
        const result =
          plan.kind === "item"
            ? await guarded(ctx, call.id, { step: "memory", target: value, work: make })
            : await make()
        switch (result.kind) {
          case "saved":
            ctx.onMemory(call.id, { kind: "saved", historyId: result.historyId })
            return { output: "Saved to memory.", failed: false }
          case "suggested":
            ctx.onMemory(call.id, { kind: "suggested", proposalId: result.proposal.id })
            return {
              output: "Suggested for memory. The user decides if it is kept.",
              failed: false,
            }
          case "known":
            return { output: "This fact is already known. Nothing was added.", failed: false }
          case "too_long":
            return {
              output: `Not saved: the text is longer than ${MEMORY_TEXT_MAX} characters. Say it shorter.`,
              failed: true,
            }
          case "secret":
            return {
              output:
                "Not saved: the text looks like a secret (a key, a token or a password). Leave the secret out and tell the user that you did.",
              failed: true,
            }
          case "empty":
            return { output: "Not saved: the text is empty.", failed: true }
          case "off":
            return { output: "Not saved: memory is off for you.", failed: true }
        }
      }

      const run = async (ctx: ToolContext, call: ToolCall): Promise<ToolOutcome> => {
        const args = parseArgs(call)
        switch (call.name) {
          case "list_files": {
            const p = place(ctx, text(args, "path"))
            const blocked = knowledgeBlock(ctx, p.full)
            if (blocked) return { output: blocked, failed: true }
            await approve(ctx, call, !p.inside, `list_files${p.inside ? "" : ":outside"}`, p.full)
            const entries = readdirSync(p.full, { withFileTypes: true })
              .slice(0, LIST_MAX)
              .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`)
            return { output: entries.join("\n") || "(empty)", failed: false }
          }
          case "read_file": {
            const p = place(ctx, text(args, "path"))
            const blocked = knowledgeBlock(ctx, p.full)
            if (blocked) return { output: blocked, failed: true }
            await approve(ctx, call, !p.inside, `read_file${p.inside ? "" : ":outside"}`, p.full)
            return { output: cut(readFileSync(p.full, "utf8"), READ_MAX), failed: false }
          }
          case "write_file": {
            const p = place(ctx, text(args, "path"))
            const blocked = knowledgeBlock(ctx, p.full)
            if (blocked) return { output: blocked, failed: true }
            await approve(ctx, call, !p.inside, `write_file${p.inside ? "" : ":outside"}`, p.full)
            mkdirSync(dirname(p.full), { recursive: true })
            const content = text(args, "content")
            writeFileSync(p.full, content)
            return { output: `Wrote ${content.length} characters to ${p.full}`, failed: false }
          }
          case "search_files": {
            // The search leaves out the sources, and the articles while knowledge is on.
            const hits = searchFiles(ctx.workspace, text(args, "query"), (dir) => {
              return knowledgeBlock(ctx, dir) !== null
            })
            return { output: hits.join("\n") || "No matches.", failed: false }
          }
          case "run_command": {
            const command = text(args, "command")
            if (!command.trim()) return { output: "No command.", failed: true }
            const reason = riskyReason(command, ctx.workspace)
            const first = command.trim().split(/\s+/)[0] ?? ""
            await approve(ctx, call, reason !== null, `run_command:${reason ?? first}`, command)
            return await runCommand(ctx, command)
          }
          case "fetch_url": {
            const url = text(args, "url")
            await approve(ctx, call, false, "fetch_url", url)
            return await fetchUrl(ctx, url)
          }
          case "ask_user": {
            const question = text(args, "question")
            const choices = Array.isArray(args.choices)
              ? args.choices.filter((c): c is string => typeof c === "string").slice(0, 8)
              : []
            const reply = await wait(ctx, call.id, { kind: "question", question, choices })
            return { output: reply.answer, failed: false }
          }
          case "browser_open":
          case "browser_read":
          case "browser_click":
          case "browser_type":
          case "browser_close":
            return await browserTool(ctx, call)
          case "save_memory":
            return await saveMemory(ctx, call, text(args, "text"))
          case "read_article":
            return await readTool(ctx, call, args)
          case "write_article":
          case "delete_article":
            return await changeTool(ctx, call, args)
          case "add_source":
            return await sourceTool(ctx, call, args)
          default:
            return { output: `Unknown tool: ${call.name}`, failed: true }
        }
      }

      const execute = async (ctx: ToolContext, call: ToolCall): Promise<ToolOutcome> => {
        try {
          return await run(ctx, call)
        } catch (error) {
          if (error instanceof Denied) return { output: "The user denied this step.", failed: true }
          if (error instanceof Refused) return { output: error.message, failed: true }
          if (ctx.signal.aborted) throw error
          return { output: error instanceof Error ? error.message : String(error), failed: true }
        }
      }

      return Tools.of({
        defs: (options) =>
          Object.values(DEFS).filter(
            (d) =>
              (options.memory || d.name !== "save_memory") &&
              (options.knowledge || !KNOWLEDGE_TOOLS.has(d.name)),
          ),
        execute,
        guarded,
        bridge: (ctx, show) => {
          let count = 0
          return {
            tools: Object.values(DEFS).filter((d) =>
              (BRIDGE_TOOL_NAMES as readonly string[]).includes(d.name),
            ),
            call: async (name, args) => {
              const call: ToolCall = { id: `app-${++count}`, name, input: JSON.stringify(args) }
              show({ type: "tool", state: "running", call })
              try {
                const outcome = await execute(ctx, call)
                show({
                  type: "tool",
                  state: outcome.failed ? "failed" : "done",
                  call,
                  output: outcome.output,
                })
                return outcome
              } catch (error) {
                // The turn stopped. The program is told, and the card is not changed any more.
                show({ type: "tool", state: "failed", call, output: "Stopped." })
                throw error
              }
            },
          }
        },
        approval: async (ctx, request) => {
          try {
            const call = { id: request.callId, name: "", input: "" }
            await approve(ctx, call, request.risky, request.key, request.summary)
            return true
          } catch (error) {
            if (error instanceof Denied) return false
            throw error
          }
        },
        browserState: (agentId) => ({
          open: platform.browser(agentId).isOpen(),
          control: control.has(agentId),
        }),
        setBrowserControl: (agentId, user) => {
          if (user) control.add(agentId)
          else control.delete(agentId)
          // The page takes the clicks and keys of the user only while the user holds the controls.
          pageOf(agentId).allowUserInput(user)
          browserChanged(agentId)
        },
        closeBrowser: (agentId) => platform.browser(agentId).close(),
        isWaiting: (agentId, callId) => waiting.has(`${agentId}:${callId}`),
        placeBrowser: (agentId, bounds) => platform.browser(agentId).place(bounds),
        respond: (agentId, callId, answer) =>
          Effect.gen(function* () {
            // A linked device that answers is named on the card (spec 012).
            const actor = yield* CurrentActor
            waiting.get(`${agentId}:${callId}`)?.(answer, actor?.name ?? null)
          }),
      })
    }),
  )
}
