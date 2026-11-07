import { isAbsolute, resolve } from "node:path"
import {
  commandReads,
  hostOf,
  insideWorkspace,
  makePlaces,
  type OutsideSource,
  type PlaceEnv,
  type SensitiveLabel,
  sendsData,
} from "@robot/shared"
import type { ToolCall } from "../providers/chat.ts"

/**
 * What the app can see of a tool step of a vendor program (spec 007, "Text node on a vendor
 * runtime"). The program runs its own tools, so the app reads the step from the name and the
 * arguments that the program reports, and works out the marks of the task from it.
 *
 * The rule when the app cannot tell: the step counts as outside content. That is the safe default,
 * because a guarded step then asks the user.
 */
export interface ProgramStep {
  /** The kind that the action log lists, or null for a step that has no rules (a tool, a plan). */
  readonly kind: "file" | "shell" | "web" | null
  readonly access: "read" | "write" | null
  /** The path, the command or the host, as the permission rules see the step. */
  readonly target: string
  /** The outside source that the step gives to the task, or null. */
  readonly outside: OutsideSource | null
  /** The credential place that the step reads, or null. */
  readonly sensitive: SensitiveLabel | null
}

const norm = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "")

const SHELL = new Set(["bash", "shell", "powershell", "runcommand", "runterminalcommand", "exec"])
const SHELL_MORE = new Set(["execute", "command", "terminal", "run", "runshellcommand"])
const READ = new Set([
  "read",
  "readfile",
  "readmanyfiles",
  "notebookread",
  "grep",
  "glob",
  "ls",
  "list",
  "listfiles",
  "listdir",
  "find",
  "search",
  "searchfiles",
  "codebasesearch",
  "view",
  "cat",
  "semsearch",
  "readlints",
])
const WRITE = new Set([
  "write",
  "writefile",
  "edit",
  "editfile",
  "multiedit",
  "notebookedit",
  "filechange",
  "applypatch",
  "delete",
  "deletefile",
  "create",
  "createfile",
  "strreplace",
])
const WEB = new Set([
  "webfetch",
  "websearch",
  "fetch",
  "fetchurl",
  "web",
  "browse",
  "browser",
  "http",
  "curl",
])
/** Tools that read nothing from outside and give nothing to the task: plans and notes. */
const QUIET = new Set(["todowrite", "todoread", "todolist", "plan", "updateplan"])

/** A command that reaches the network, even with no data to send: what it prints comes from outside. */
const NETWORK_USE =
  /(?:^|[\s;&|(])(?:curl|wget|http|https|xh|scp|rsync|nc|ncat|netcat|ftp|sftp|telnet|ssh|gh|git\s+(?:clone|fetch|pull))\s/i

const parse = (input: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(input || "{}")
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
const first = (args: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) if (typeof args[key] === "string" && args[key]) return args[key] as string
  return ""
}

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file", "directory"]
const COMMAND_KEYS = ["command", "cmd", "script"]
const URL_KEYS = ["url", "uri", "address"]

export const programStep = (
  env: PlaceEnv,
  workspace: string,
  call: Pick<ToolCall, "name" | "input">,
): ProgramStep => {
  const name = norm(call.name)
  const args = parse(call.input)
  const places = makePlaces(env)
  const none = { kind: null, access: null, target: "", outside: null, sensitive: null } as const

  if (QUIET.has(name)) return none

  if (SHELL.has(name) || SHELL_MORE.has(name)) {
    const command = first(args, COMMAND_KEYS)
    // A command that uses the network brings text from outside to the task.
    return {
      kind: "shell",
      access: null,
      target: command,
      outside:
        command !== "" && (sendsData(command) || NETWORK_USE.test(`${command} `))
          ? { kind: "page", host: "" }
          : null,
      sensitive: command ? commandReads(env, command) : null,
    }
  }

  if (WEB.has(name)) {
    const url = first(args, URL_KEYS)
    const host = hostOf(url)
    return {
      kind: host ? "web" : null,
      access: null,
      target: host,
      outside: { kind: "page", host },
      sensitive: null,
    }
  }

  if (READ.has(name) || WRITE.has(name)) {
    const raw = first(args, PATH_KEYS)
    const write = WRITE.has(name)
    // A search with no path works in the folder of the workflow.
    const path = raw === "" ? workspace : isAbsolute(raw) ? raw : resolve(workspace, raw)
    const outside = !insideWorkspace(env.real(path), env.real(workspace))
    return {
      kind: "file",
      access: write ? "write" : "read",
      target: path,
      // A read of a path outside the folder is text from outside. A write brings none.
      outside: !write && outside ? { kind: "page", host: "" } : null,
      sensitive: write ? null : places.credential(path),
    }
  }

  // A tool that the app does not know, for example a tool of an MCP server: outside content.
  const dot = call.name.indexOf(".")
  const server =
    dot > 0
      ? call.name.slice(0, dot)
      : call.name.startsWith("mcp__")
        ? (call.name.split("__")[1] ?? "")
        : ""
  return {
    ...none,
    outside: server
      ? { kind: "connection", connection: server, tool: call.name.slice(dot > 0 ? dot + 1 : 0) }
      : { kind: "page", host: "" },
  }
}
