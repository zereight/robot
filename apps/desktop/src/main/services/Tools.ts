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
  type ApprovalAnswer,
  insideWorkspace,
  needsApproval,
  type PermissionLevel,
  riskyReason,
  type ToolAsk,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { ToolOutcome } from "../providers/agent.ts"
import type { ToolCall, ToolDef } from "../providers/chat.ts"
import type { ApprovalRequest } from "../runtimes/types.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { Memory } from "./Memory.ts"
import { Platform } from "./Platform.ts"

export interface ToolContext {
  readonly agentId: string
  readonly workspace: string
  readonly permission: PermissionLevel
  readonly signal: AbortSignal
  /** Shows a card that waits for the user (`ask`), or hides it again (`null`). */
  readonly onWaiting: (callId: string, ask: ToolAsk | null) => void
  /** Records the memory item that a call saved, so its card can offer undo. */
  readonly onMemory: (callId: string, memoryId: string) => void
}

export interface ToolsService {
  /** The tools that an agent may call. Memory tools are left out when memory is off. */
  defs(memoryEnabled: boolean): readonly ToolDef[]
  execute(context: ToolContext, call: ToolCall): Promise<ToolOutcome>
  /**
   * Asks about a step that a vendor program wants to take, by the permission level and the risk.
   * Resolves true to go on and false when the user denies. Rejects when the turn stops.
   */
  approval(context: ToolContext, request: ApprovalRequest): Promise<boolean>
  /** Answers a card that waits. Unknown cards are ignored. */
  respond(agentId: string, callId: string, answer: string): Effect.Effect<void>
  /** Whether the browser window of an agent is open, and whether the user holds the controls. */
  browserState(agentId: string): { open: boolean; control: boolean }
  /** The user takes the controls (`true`) or gives them back (`false`). */
  setBrowserControl(agentId: string, control: boolean): void
  closeBrowser(agentId: string): void
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
      "Open a web page in a browser window that the user can watch. Logins stay between runs.",
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
    description: "Close the browser window.",
    schema: object({}, []),
  },
  save_memory: {
    name: "save_memory",
    description:
      "Save one short, lasting fact (a preference, a name, a decision) to your memory. Do not save passwords or keys.",
    schema: object({ text: str("The fact, in one sentence.") }, ["text"]),
  },
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

export class Tools extends Context.Service<Tools, ToolsService>()("robot/main/Tools") {
  static readonly layer = Layer.effect(
    Tools,
    Effect.gen(function* () {
      const db = yield* Database
      const memory = yield* Memory
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
            browserChanged(agentId)
          })
        }
        return page
      }
      const waiting = new Map<string, (answer: string) => void>()

      const allowed = (agentId: string, key: string) =>
        db.get("SELECT 1 AS x FROM agent_allow WHERE agent_id = ? AND key = ?", agentId, key) !==
        undefined
      const allow = (agentId: string, key: string) =>
        db.run("INSERT OR IGNORE INTO agent_allow (agent_id, key) VALUES (?, ?)", agentId, key)

      /** Waits for the user to answer a card. Rejects when the turn stops. */
      const wait = (ctx: ToolContext, callId: string, ask: ToolAsk) =>
        new Promise<string>((resolveAnswer, reject) => {
          const id = `${ctx.agentId}:${callId}`
          const stop = () => {
            waiting.delete(id)
            reject(new Error("stopped"))
          }
          if (ctx.signal.aborted) return stop()
          ctx.signal.addEventListener("abort", stop, { once: true })
          waiting.set(id, (answer) => {
            waiting.delete(id)
            ctx.signal.removeEventListener("abort", stop)
            resolveAnswer(answer)
          })
          ctx.onWaiting(callId, ask)
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
        const answer = (await wait(ctx, call.id, { kind: "approval", summary })) as ApprovalAnswer
        if (answer === "always") allow(ctx.agentId, key)
        else if (answer !== "allow") throw new Denied()
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

      const searchFiles = (root: string, query: string) => {
        const hits: string[] = []
        const q = query.toLocaleLowerCase()
        const walk = (dir: string) => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (hits.length >= SEARCH_MAX) return
            const path = join(dir, entry.name)
            if (entry.isDirectory()) {
              if (!SKIP_DIRS.has(entry.name)) walk(path)
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

      const fetchUrl = async (ctx: ToolContext, url: string): Promise<ToolOutcome> => {
        if (!/^https?:\/\//i.test(url))
          return { output: "Only http and https addresses work.", failed: true }
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
        return {
          output: cut(`[status ${response.status}]\n${body}`, FETCH_MAX),
          failed: !response.ok,
        }
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
            browserChanged(ctx.agentId)
            return { output: `Opened ${opened.url}\nTitle: ${opened.title}`, failed: false }
          }
          await approve(ctx, call, false, "browser_act", `${call.name} ${call.input}`)
          await whileUserHolds(ctx)
          if (ctx.signal.aborted) throw new Error("stopped")
          if (call.name === "browser_read") {
            const read = await page.read()
            return { output: `${read.url}\nTitle: ${read.title}\n\n${read.text}`, failed: false }
          }
          if (call.name === "browser_click") await page.click(text(args, "selector"))
          else await page.type(text(args, "selector"), text(args, "text"))
          return { output: "Done.", failed: false }
        } finally {
          ctx.signal.removeEventListener("abort", stop)
        }
      }

      const run = async (ctx: ToolContext, call: ToolCall): Promise<ToolOutcome> => {
        const args = parseArgs(call)
        switch (call.name) {
          case "list_files": {
            const p = place(ctx, text(args, "path"))
            await approve(ctx, call, !p.inside, `list_files${p.inside ? "" : ":outside"}`, p.full)
            const entries = readdirSync(p.full, { withFileTypes: true })
              .slice(0, LIST_MAX)
              .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`)
            return { output: entries.join("\n") || "(empty)", failed: false }
          }
          case "read_file": {
            const p = place(ctx, text(args, "path"))
            await approve(ctx, call, !p.inside, `read_file${p.inside ? "" : ":outside"}`, p.full)
            return { output: cut(readFileSync(p.full, "utf8"), READ_MAX), failed: false }
          }
          case "write_file": {
            const p = place(ctx, text(args, "path"))
            await approve(ctx, call, !p.inside, `write_file${p.inside ? "" : ":outside"}`, p.full)
            mkdirSync(dirname(p.full), { recursive: true })
            const content = text(args, "content")
            writeFileSync(p.full, content)
            return { output: `Wrote ${content.length} characters to ${p.full}`, failed: false }
          }
          case "search_files": {
            const hits = searchFiles(ctx.workspace, text(args, "query"))
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
            const answer = await wait(ctx, call.id, { kind: "question", question, choices })
            return { output: answer, failed: false }
          }
          case "browser_open":
          case "browser_read":
          case "browser_click":
          case "browser_type":
          case "browser_close":
            return await browserTool(ctx, call)
          case "save_memory": {
            const item = await Effect.runPromise(
              memory.add(ctx.agentId, text(args, "text"), "agent"),
            )
            ctx.onMemory(call.id, item.id)
            return { output: "Saved to memory.", failed: false }
          }
          default:
            return { output: `Unknown tool: ${call.name}`, failed: true }
        }
      }

      return Tools.of({
        defs: (memoryEnabled) =>
          Object.values(DEFS).filter((d) => memoryEnabled || d.name !== "save_memory"),
        execute: async (ctx, call) => {
          try {
            return await run(ctx, call)
          } catch (error) {
            if (error instanceof Denied)
              return { output: "The user denied this step.", failed: true }
            if (ctx.signal.aborted) throw error
            return { output: error instanceof Error ? error.message : String(error), failed: true }
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
          browserChanged(agentId)
        },
        closeBrowser: (agentId) => platform.browser(agentId).close(),
        respond: (agentId, callId, answer) =>
          Effect.sync(() => waiting.get(`${agentId}:${callId}`)?.(answer)),
      })
    }),
  )
}
