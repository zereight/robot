import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import {
  type ActionDecider,
  type ApprovalAnswer,
  classifyHostWriting,
  commandChangesControl,
  commandReads,
  hostOf,
  insideWorkspace,
  levelForNode,
  makePlaces,
  type OutsideSource,
  type PermissionLevel,
  type PlaceEnv,
  type RefusalReason,
  type RuleRef,
  type RuleStep,
  type RuleVerdict,
  readOnlyRefuses,
  riskyReason,
  ruleOutcome,
  type SensitiveLabel,
  sendsData,
} from "@robot/shared"
import type { ToolOutcome } from "../providers/agent.ts"
import type { ToolCall, ToolDef } from "../providers/chat.ts"
import type { ApprovalRequest } from "../runtimes/types.ts"
import { checkedFetch } from "../web/fetch.ts"
import type { ActionLogService } from "./ActionLog.ts"
import type { CardReply } from "./Cards.ts"
import type { PlatformService } from "./Platform.ts"
import type { RulesService } from "./Rules.ts"
import { realOf } from "./realPath.ts"

/**
 * The tools of a text node (spec 007, 010): files, shell commands, the fetch of a web page and the
 * question card. They work in the folder of the workflow, at the permission level of the node.
 *
 * Not built here, and listed in the report of W6: the browser, computer use, memory (008), the
 * tools of connections (018), saved secrets (020) and the tools of test devices (032 to 034).
 */

const READ_MAX = 100_000
const OUTPUT_MAX = 20_000
const FETCH_MAX = 50_000
const LIST_MAX = 200
const SEARCH_MAX = 50
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build"])
const FETCH_TIMEOUT_MS = 20_000

/** The timeout of a shell command. A test may make it shorter. */
export const toolClock = { commandMs: 120_000 }

const FETCH_FAILURES = {
  invalid: "The address is not valid.",
  scheme: "Only http and https addresses work.",
  redirects: "The address redirects too many times.",
  timeout: "The page took too long to answer.",
  network: "The page could not be reached.",
  stopped: "Stopped.",
} as const

const READ_ONLY_MESSAGE =
  "Refused: this node is at the permission level Read only. This step writes, runs a command or uses a tool that Read only does not allow. Read, list, search and fetch instead, or tell the user what you need."
const RULE_DENIED_MESSAGE =
  "Denied by a rule: the user keeps a rule that does not let you take this step. Do not look for another way to take it; tell the user what you needed."
const ADDRESS_MESSAGE =
  "Refused: this address is not allowed. It is a link-local or a cloud metadata address. Do not try another way to reach it; tell the user what you needed."
const DENIED_MESSAGE = "The user denied this step."
export const REPEATED_READ_TEXT =
  "Refused: you read this already twice, and the result did not change. Use the result that you have."

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
})
const str = (description: string) => ({ type: "string", description })

export const NODE_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "list_files",
    description: "List the files and folders in a folder of your workspace.",
    schema: object({ path: str("Folder, relative to the workspace. Default: the workspace.") }, []),
  },
  {
    name: "read_file",
    description: "Read a text file.",
    schema: object({ path: str("File path, relative to the workspace.") }, ["path"]),
  },
  {
    name: "write_file",
    description: "Write a text file. Folders are made when needed. An existing file is replaced.",
    schema: object({ path: str("File path."), content: str("The whole new content.") }, [
      "path",
      "content",
    ]),
  },
  {
    name: "search_files",
    description: "Search the text files of your workspace for a text. Returns matching lines.",
    schema: object({ query: str("The text to look for.") }, ["query"]),
  },
  {
    name: "run_command",
    description: "Run a shell command in your workspace and return its output.",
    schema: object({ command: str("The command line.") }, ["command"]),
  },
  {
    name: "fetch_url",
    description: "Fetch a web page or file with GET and return its text.",
    schema: object({ url: str("An http or https address.") }, ["url"]),
  },
  {
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
]

/** The marks that a task holds (spec 007, "Outside content" and "Sensitive places"). */
export interface TaskMarks {
  outside: OutsideSource | null
  program: boolean
  sensitive: SensitiveLabel | null
}

/** What a tool asks the engine to show: the engine adds the task and the run. */
export interface NodeCard {
  readonly kind: "approval" | "question"
  readonly summary: string
  readonly step: "file" | "shell" | "web" | "ask"
  readonly once: boolean
  readonly outside?: OutsideSource | null
  readonly sensitive?: SensitiveLabel | null
  readonly unreadable?: boolean
  readonly choices?: readonly string[]
}

export interface NodeToolContext {
  readonly workflowId: string
  readonly workspace: string
  /** The level of the node: the level of its workflow, or a stricter one (spec 010). */
  readonly level: PermissionLevel
  readonly signal: AbortSignal
  readonly taskId: string
  readonly marks: TaskMarks
  /** Shows a card and waits for the answer. It rejects when the task stops. */
  readonly ask: (card: NodeCard) => Promise<CardReply>
  /** Called after a step that changed the marks of the task. */
  readonly onMarks: () => void
}

export interface NodeToolsDeps {
  readonly rules: RulesService
  readonly actionLog: ActionLogService
  readonly platform: PlatformService
}

/** An error that carries a refusal to the node as a failed step. */
class Refusal extends Error {
  constructor(
    readonly text: string,
    readonly reason?: RefusalReason,
  ) {
    super(text)
  }
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

type Kind = "file" | "shell" | "web"

export const makeNodeTools = (deps: NodeToolsDeps) => {
  const { rules, actionLog, platform } = deps

  const placeEnv = (ctx: NodeToolContext): PlaceEnv => ({
    home: platform.homeDir,
    real: realOf,
    data: {
      folder: platform.dataDir,
      except: [platform.defaultWorkspaceRoot, ctx.workspace],
    },
  })

  /** The repeated-read guard of a task: a read with the same result a third time is refused. */
  const reads = new WeakMap<AbortSignal, Map<string, { result: string; times: number }>>()
  const repeated = (ctx: NodeToolContext, target: string, result: string): ToolOutcome | null => {
    let seen = reads.get(ctx.signal)
    if (!seen) {
      seen = new Map()
      reads.set(ctx.signal, seen)
    }
    const before = seen.get(target)
    if (before && before.result === result) {
      before.times++
      if (before.times > 2) return { output: REPEATED_READ_TEXT, failed: true }
    } else seen.set(target, { result, times: 1 })
    return null
  }

  /** What one gate decided, for the log. */
  interface Decided {
    by: ActionDecider
    rule: RuleRef | null
  }

  /**
   * The order of spec 007 for one step of a node:
   * 1. a Deny rule refuses it at every level;
   * 2. a step that sends data out in a task that holds a sensitive read asks with Allow once and
   *    Deny only, also when an Allow rule matches ("Full access" runs it);
   * 3. a rule that cannot be read asks, an Allow rule runs the step, and the level decides.
   * "Read only" came first, in `execute`. A node has no words of the user, so a checked step of
   * "Ask when unsure" always asks the user: that level works as "Ask for risky steps" here.
   */
  const gate = async (
    ctx: NodeToolContext,
    input: {
      readonly kind: Kind
      readonly step: RuleStep | null
      readonly summary: string
      readonly risky: boolean
      readonly sends: boolean
      /** The sensitive read that this step itself makes, when the task held none before. */
      readonly sensitive?: SensitiveLabel | null
    },
  ): Promise<Decided> => {
    const held = ctx.marks.sensitive ?? input.sensitive ?? null
    const verdict: RuleVerdict = input.step
      ? rules.verdict(ctx.workflowId, input.step)
      : { kind: "none" }
    if (verdict.kind === "deny")
      throw Object.assign(new Refusal(RULE_DENIED_MESSAGE, "rule"), { rule: verdict.rule })
    if (input.sends && held !== null && verdict.kind !== "unreadable") {
      if (ctx.level === "full") return { by: "level", rule: null }
      const reply = await ctx.ask({
        kind: "approval",
        summary: input.summary,
        step: input.kind,
        once: true,
        outside: ctx.marks.outside,
        sensitive: held,
      })
      if (reply.answer === "deny") throw new Refusal(DENIED_MESSAGE)
      return { by: "user", rule: null }
    }
    const level = levelForNode(ctx.level)
    const outcome = ruleOutcome({ level, risky: input.risky, verdict })
    if (outcome === "allow_rule" && verdict.kind === "allow")
      return { by: "allow_rule", rule: verdict.rule }
    if (outcome === "run") return { by: "level", rule: null }
    const unreadable = outcome === "ask_unreadable"
    const save = !unreadable && input.step !== null && rules.canSave(ctx.workflowId, input.step)
    const reply = await ctx.ask({
      kind: "approval",
      summary: input.summary,
      step: input.kind,
      once: !save,
      outside: ctx.marks.outside,
      sensitive: ctx.marks.sensitive,
      unreadable,
    })
    const answer = reply.answer as ApprovalAnswer
    if (answer === "deny") throw new Refusal(DENIED_MESSAGE)
    if (answer === "always" && save && input.step) rules.saveFromCard(ctx.workflowId, input.step)
    return {
      by: unreadable ? "unreadable_rule" : "user",
      rule: unreadable && verdict.kind === "unreadable" ? verdict.rule : null,
    }
  }

  const log = (
    ctx: NodeToolContext,
    kind: Kind,
    access: "read" | "write" | null,
    target: string,
    decided: Decided,
    result: "ran" | "failed" | "refused" | "stopped",
  ) =>
    actionLog.add({
      workflowId: ctx.workflowId,
      kind,
      ...(kind === "file" ? { access } : {}),
      target,
      decidedBy: decided.by,
      result,
      taskId: ctx.taskId,
      outside: ctx.marks.outside,
      sensitive: ctx.marks.sensitive,
      ...(decided.rule ? { rule: decided.rule } : {}),
    })

  const markSensitive = (ctx: NodeToolContext, label: SensitiveLabel | null) => {
    if (!label || ctx.marks.sensitive !== null) return
    ctx.marks.sensitive = label
    ctx.onMarks()
  }
  const markOutside = (ctx: NodeToolContext, source: OutsideSource) => {
    if (ctx.marks.outside !== null) return
    ctx.marks.outside = source
    ctx.onMarks()
  }

  const place = (ctx: NodeToolContext, path: string) => {
    const full = resolve(ctx.workspace, path || ".")
    const inside = insideWorkspace(realOf(full), realOf(ctx.workspace))
    return { full, inside }
  }

  /** A step that the log lists, run through the gate. Refusals are logged and re-thrown. */
  const guardedStep = async <A>(
    ctx: NodeToolContext,
    input: Parameters<typeof gate>[1] & {
      readonly access: "read" | "write" | null
      readonly target: string
    },
    work: (decided: Decided) => Promise<A>,
  ): Promise<A> => {
    let decided: Decided
    try {
      decided = await gate(ctx, input)
    } catch (error) {
      if (error instanceof Refusal) {
        const rule = (error as Refusal & { rule?: RuleRef }).rule ?? null
        log(
          ctx,
          input.kind,
          input.access,
          input.target,
          { by: rule ? "deny_rule" : "user", rule },
          "refused",
        )
      } else if (ctx.signal.aborted)
        log(ctx, input.kind, input.access, input.target, { by: "level", rule: null }, "stopped")
      throw error
    }
    try {
      const value = await work(decided)
      log(ctx, input.kind, input.access, input.target, decided, "ran")
      return value
    } catch (error) {
      log(
        ctx,
        input.kind,
        input.access,
        input.target,
        decided,
        ctx.signal.aborted ? "stopped" : "failed",
      )
      throw error
    }
  }

  const runCommand = (ctx: NodeToolContext, command: string) =>
    new Promise<ToolOutcome>((done) => {
      const child = spawn(command, {
        cwd: ctx.workspace,
        shell: true,
        env: { ...process.env, HOME: platform.homeDir },
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
        } catch {
          // The process is gone already.
        }
      }
      const timer = setTimeout(kill, toolClock.commandMs)
      ctx.signal.addEventListener("abort", kill, { once: true })
      child.on("error", (e) => {
        clearTimeout(timer)
        done({ output: String(e.message), failed: true })
      })
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener("abort", kill)
        done({
          output: `${cut(out, OUTPUT_MAX)}\n${signal ? `[ended by ${signal}]` : `[exit code ${code}]`}`,
          failed: code !== 0,
        })
      })
    })

  const searchFiles = (
    root: string,
    query: string,
    credential: (path: string) => SensitiveLabel | null,
  ) => {
    const hits: string[] = []
    let read: SensitiveLabel | null = null
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
            if (line.toLocaleLowerCase().includes(q) && !line.includes("\0")) {
              hits.push(`${relative(root, path)}:${i + 1}: ${line.trim().slice(0, 200)}`)
              read ??= credential(path)
            }
            if (hits.length >= SEARCH_MAX) return
          }
        }
      }
    }
    walk(root)
    return { hits, read }
  }

  /** Fetches a page with GET (spec 007, "Addresses of a web page fetch"). */
  const fetchUrl = async (ctx: NodeToolContext, url: string): Promise<ToolOutcome> => {
    if (!/^https?:\/\//i.test(url))
      return { output: "Only http and https addresses work.", failed: true }
    const host = hostOf(url)
    const writing = classifyHostWriting(host)
    const step: RuleStep = { kind: "web", host }
    if (writing.kind === "never") {
      log(ctx, "web", null, url, { by: "app", rule: null }, "refused")
      return { output: ADDRESS_MESSAGE, failed: true, notRun: true, refused: "address" }
    }
    return guardedStep(
      ctx,
      {
        kind: "web",
        step,
        summary: url,
        // A fetch is not a risky step by itself. It sends data out in a task that holds a
        // sensitive read, and a local address is a hard step that the fetch asks for below.
        risky: false,
        sends: true,
        access: null,
        target: url,
      },
      async () => {
        let hopDenied = false
        const result = await checkedFetch({
          url,
          signal: ctx.signal,
          resolve: platform.resolveHost,
          timeoutMs: FETCH_TIMEOUT_MS,
          allowLocal: async ({ host: local, url: stepUrl, byName }) => {
            const hop = rules.verdict(ctx.workflowId, { kind: "web", host: local })
            if (hop.kind === "deny") {
              hopDenied = true
              return false
            }
            if (hop.kind === "allow" && !byName) return true
            if (ctx.level === "full" && hop.kind !== "unreadable") return true
            const reply = await ctx.ask({
              kind: "approval",
              summary: stepUrl,
              step: "web",
              once: byName,
              outside: ctx.marks.outside,
              sensitive: ctx.marks.sensitive,
            })
            if (reply.answer === "always" && !byName)
              rules.saveFromCard(ctx.workflowId, { kind: "web", host: local })
            return reply.answer !== "deny"
          },
        })
        if (result.kind === "refused")
          throw Object.assign(new Refusal(ADDRESS_MESSAGE, "address"), { app: true })
        if (result.kind === "denied")
          throw new Refusal(
            hopDenied ? RULE_DENIED_MESSAGE : DENIED_MESSAGE,
            hopDenied ? "rule" : undefined,
          )
        if (result.kind === "failed") {
          if (result.reason === "stopped" || ctx.signal.aborted) throw new Error("stopped")
          throw new Error(FETCH_FAILURES[result.reason])
        }
        let body = result.body
        if (result.contentType.includes("html"))
          body = body
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        // The text of the page reaches the node: the task holds outside content from now on.
        markOutside(ctx, { kind: "page", host: hostOf(result.url || url) })
        const output = cut(`[status ${result.status}]\n${body}`, FETCH_MAX)
        return repeated(ctx, url, output) ?? { output, failed: !result.ok }
      },
    )
  }

  const run = async (ctx: NodeToolContext, call: ToolCall): Promise<ToolOutcome> => {
    const args = parseArgs(call)
    const places = makePlaces(placeEnv(ctx))
    switch (call.name) {
      case "list_files": {
        const p = place(ctx, text(args, "path"))
        const label = places.credential(p.full)
        return guardedStep(
          ctx,
          {
            kind: "file",
            step: { kind: "file", path: p.full },
            summary: p.full,
            risky: !p.inside || label === "robot",
            sends: false,
            access: "read",
            target: p.full,
          },
          async () => {
            const entries = readdirSync(p.full, { withFileTypes: true })
              .slice(0, LIST_MAX)
              .map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`)
            markSensitive(ctx, label)
            return { output: entries.join("\n") || "(empty)", failed: false }
          },
        )
      }
      case "read_file": {
        const p = place(ctx, text(args, "path"))
        const label = places.credential(p.full)
        return guardedStep(
          ctx,
          {
            kind: "file",
            step: { kind: "file", path: p.full },
            summary: p.full,
            risky: !p.inside || label === "robot",
            sends: false,
            access: "read",
            target: p.full,
          },
          async () => {
            const output = cut(readFileSync(p.full, "utf8"), READ_MAX)
            markSensitive(ctx, label)
            return repeated(ctx, p.full, output) ?? { output, failed: false }
          },
        )
      }
      case "write_file": {
        const p = place(ctx, text(args, "path"))
        const control = places.control(p.full) || places.credential(p.full) === "robot"
        return guardedStep(
          ctx,
          {
            kind: "file",
            step: { kind: "file", path: p.full },
            summary: p.full,
            risky: control || !p.inside,
            sends: false,
            access: "write",
            target: p.full,
          },
          async () => {
            mkdirSync(dirname(p.full), { recursive: true })
            const content = text(args, "content")
            writeFileSync(p.full, content)
            return { output: `Wrote ${content.length} characters to ${p.full}`, failed: false }
          },
        )
      }
      case "search_files": {
        const { hits, read } = searchFiles(ctx.workspace, text(args, "query"), (path) =>
          places.credential(path),
        )
        markSensitive(ctx, read ?? places.credential(ctx.workspace))
        return { output: hits.join("\n") || "No matches.", failed: false }
      }
      case "run_command": {
        const command = text(args, "command")
        if (!command.trim()) return { output: "No command.", failed: true }
        const env = placeEnv(ctx)
        const reason = riskyReason(command, ctx.workspace)
        const reads = commandReads(env, command)
        const hard = commandChangesControl(env, command, ctx.workspace)
        return guardedStep(
          ctx,
          {
            kind: "shell",
            step: { kind: "shell", command },
            summary: command,
            risky: hard || reason !== null,
            // A command that names a credential place is a sensitive read for its own decision
            // when it also sends data out (spec 007).
            sends: sendsData(command),
            sensitive: reads,
            access: null,
            target: command,
          },
          async () => {
            markSensitive(ctx, reads)
            return runCommand(ctx, command)
          },
        )
      }
      case "fetch_url":
        return fetchUrl(ctx, text(args, "url"))
      case "ask_user": {
        const question = text(args, "question")
        const choices = Array.isArray(args.choices)
          ? args.choices.filter((c): c is string => typeof c === "string").slice(0, 8)
          : []
        const reply = await ctx.ask({
          kind: "question",
          summary: question,
          step: "ask",
          once: true,
          choices,
        })
        return { output: reply.answer, failed: false }
      }
      default:
        return { output: `Unknown tool: ${call.name}`, failed: true }
    }
  }

  const execute = async (ctx: NodeToolContext, call: ToolCall): Promise<ToolOutcome> => {
    // "Read only" comes first: before approvals and before any rule (spec 007).
    if (readOnlyRefuses(ctx.level, call.name)) {
      const args = parseArgs(call)
      const kind: Kind | null =
        call.name === "write_file" ? "file" : call.name === "run_command" ? "shell" : null
      if (kind)
        log(
          ctx,
          kind,
          kind === "file" ? "write" : null,
          text(args, kind === "file" ? "path" : "command"),
          { by: "level", rule: null },
          "refused",
        )
      return { output: READ_ONLY_MESSAGE, failed: true, refused: "read_only", notRun: true }
    }
    try {
      return await run(ctx, call)
    } catch (error) {
      if (error instanceof Refusal)
        return {
          output: error.text,
          failed: true,
          notRun: true,
          ...(error.reason ? { refused: error.reason } : {}),
        }
      if (ctx.signal.aborted) throw error
      return { output: error instanceof Error ? error.message : String(error), failed: true }
    }
  }

  /**
   * A step that a vendor program wants to take (spec 007, "Text node on a vendor runtime"). The
   * program decides its own steps, and the app shows them as approval cards. Resolves true to go
   * on.
   */
  const approval = async (ctx: NodeToolContext, request: ApprovalRequest): Promise<boolean> => {
    const kind: Kind | null =
      request.step?.kind === "file" ||
      request.step?.kind === "shell" ||
      request.step?.kind === "web"
        ? request.step.kind
        : null
    const verdict: RuleVerdict = request.step
      ? rules.verdict(ctx.workflowId, request.step)
      : { kind: "none" }
    if (verdict.kind === "deny") {
      if (kind)
        log(ctx, kind, null, request.summary, { by: "deny_rule", rule: verdict.rule }, "refused")
      return false
    }
    const outcome = ruleOutcome({
      level: levelForNode(ctx.level),
      risky: request.risky,
      verdict,
    })
    if (outcome === "allow_rule") return true
    if (outcome === "run") return true
    const save =
      outcome === "ask" && request.step !== undefined && rules.canSave(ctx.workflowId, request.step)
    const reply = await ctx.ask({
      kind: "approval",
      summary: request.summary,
      step: kind ?? "shell",
      once: !save,
      outside: ctx.marks.outside,
      sensitive: ctx.marks.sensitive,
      unreadable: outcome === "ask_unreadable",
    })
    if (reply.answer === "always" && save && request.step)
      rules.saveFromCard(ctx.workflowId, request.step)
    return reply.answer !== "deny"
  }

  return { defs: NODE_TOOL_DEFS, execute, approval }
}

export type NodeTools = ReturnType<typeof makeNodeTools>
