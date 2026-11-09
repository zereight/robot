import {
  catalogues,
  type MessageKey,
  type MessageParams,
  type OutsideSource,
  type SensitiveLabel,
} from "@robot/shared"

type T = (key: MessageKey, params?: MessageParams) => string

/** The words for the first source of outside content (spec 007). */
export const outsideText = (t: T, source: OutsideSource): string => {
  switch (source.kind) {
    case "page":
      return source.host
        ? t("outside.source.page", { host: source.host })
        : t("outside.source.pageUnknown")
    case "connection":
      return t("outside.source.connection", { tool: source.tool, connection: source.connection })
    case "secret":
      return t("outside.source.secret", { name: source.name })
    case "routine":
      return t("outside.source.routine", { name: source.name })
    case "agent":
      return t("outside.source.agent", { name: source.name })
    case "teams":
      return t("outside.source.teams")
  }
}

export const sensitiveText = (t: T, label: SensitiveLabel): string =>
  t(`sensitive.label.${label}` as MessageKey)

/**
 * The reason of a task or a run in the language of the window. The engine stores a code and the
 * English words. A code that the window knows is translated; any other reason (the text of a
 * provider error, for example) shows as it is.
 */
export const reasonText = (t: T, code: string | null, text: string | null): string | null => {
  if (code === "user" || code === "run" || code === "restart")
    return t(`runs.reason.${code}` as MessageKey)
  if (code === "no_model") return t("runs.reason.no_model")
  if (code === "provider_not_connected") return t("error.provider_not_connected")
  if (code === "node_failed" || code === "node_blocked")
    return t(`runs.reason.${code}` as MessageKey)
  const counted = /^(silent|steps):(\d+)$/.exec(code ?? "")
  if (counted) return t(`runs.reason.${counted[1]}` as MessageKey, { count: Number(counted[2]) })
  if (code === "blocked") return t("runs.reason.blocked", { reason: text ?? "" })
  if (code === "approval" || code === "question")
    return t(`runs.reason.${code}` as MessageKey, { step: text ?? "" })
  if (code === "pick") return t("runs.reason.pick")
  if (code === "verdict") return t("runs.reason.verdict")
  if (code === "control") return t("runs.reason.control")
  // A queued task waits for a free slot or behind a node (spec 005, "States and reasons").
  if (code === "slot") return t("tasks.reason.slot", { count: Number(text) || 0 })
  if (code === "behind") return t("tasks.reason.behindNode", { node: text ?? "" })
  if (code === "run_queue_full") return t("error.run_queue_full", { detail: text ?? "" })
  if (code === "engine") return t("error.engine", { detail: text ?? "" })
  if (code === "worktree_failed") return t("error.worktree_failed", { detail: text ?? "" })
  // A failure of the app has a code with words of its own, also in the other language.
  if (code && `error.${code}` in catalogues.en) return t(`error.${code}` as MessageKey)
  return text
}
