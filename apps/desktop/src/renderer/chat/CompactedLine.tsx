import type { WorkflowChatMessage } from "@robot/shared"
import { Show } from "solid-js"
import { outsideText } from "../lib/runText.ts"
import { useApp } from "../state/app.tsx"
import styles from "./chat.module.css"

/** The part of a row that is the line "Compacted", or undefined. */
export const compactedPart = (message: WorkflowChatMessage) => {
  for (const part of message.parts) if (part.kind === "compacted") return part
  return undefined
}

/**
 * The line "Compacted" (spec 003, "Compact"). It marks the place of a compact and opens to the
 * summary. The chat keeps every row above it. A summary that holds outside content says so (spec
 * 007).
 */
export const CompactedLine = (props: { message: WorkflowChatMessage }) => {
  const { t } = useApp()
  const part = () => compactedPart(props.message)
  return (
    <Show when={part()}>
      {(p) => (
        <details
          class={styles.compacted}
          data-testid="message-compacted"
          data-auto={p().auto}
          id={`message-${props.message.id}`}
        >
          <summary>{t("chat.compacted")}</summary>
          <div class={styles.compactedBody}>
            <Show when={p().auto}>
              <p class={styles.note} data-testid="compacted-auto">
                {t("chat.compacted.auto")}
              </p>
            </Show>
            <Show when={p().marks.outside}>
              {(source) => (
                <p class={styles.note} data-testid="compacted-mark-outside">
                  {t("chat.marks.outside", { source: outsideText(t, source()) })}
                </p>
              )}
            </Show>
            <Show when={p().marks.program}>
              <p class={styles.note} data-testid="compacted-mark-program">
                {t("chat.marks.program")}
              </p>
            </Show>
            <p class={styles.compactedSummary} data-testid="compacted-summary">
              {p().summary}
            </p>
          </div>
        </details>
      )}
    </Show>
  )
}
