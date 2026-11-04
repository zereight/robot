import { type ListedStep, readStepList } from "@robot/shared"

// The list of steps (a plan) that a vendor program reports (spec 006, "Rules"; 005, "Keep going").
// Each program has its own shape for it. Only the shapes that the vendors document are read here.

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" ? (value as Json) : {}
const str = (value: unknown) => (typeof value === "string" ? value : "")

/**
 * The list of Claude Code (the tool TodoWrite) and of opencode (the tool todowrite): entries with
 * `content` and a `status` of pending, in_progress, completed (opencode also cancelled). A step
 * that is cancelled is not open. Null when the input holds no list.
 */
export const planFromTodos = (todos: unknown): ListedStep[] | null =>
  Array.isArray(todos)
    ? readStepList(
        todos.map((todo) => ({
          label: str(obj(todo).content),
          done: obj(todo).status === "completed" || obj(todo).status === "cancelled",
        })),
      )
    : null

/** The list of Codex (the item todo_list): entries with `text` and `completed`. */
export const planFromItems = (items: unknown): ListedStep[] | null =>
  Array.isArray(items)
    ? readStepList(
        items.map((item) => ({
          label: str(obj(item).text),
          done: obj(item).completed === true,
        })),
      )
    : null
