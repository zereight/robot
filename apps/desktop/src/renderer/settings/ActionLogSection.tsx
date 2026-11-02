import type { ActionLogEntry, ActionResult, MessageKey } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { outsideSourceText } from "../lib/outside.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Segmented } from "../ui/controls.tsx"
import styles from "./settings.module.css"

type ResultFilter = ActionResult | "all"
const RESULTS: readonly ResultFilter[] = ["all", "ran", "failed", "refused", "stopped"]

/**
 * The action log of spec 007, newest first, with a filter by result. Each entry says whether the
 * turn held outside content and names its first source.
 */
export const ActionLogSection = () => {
  const app = useApp()
  const { t } = app
  const [result, setResult] = createSignal<ResultFilter>("all")
  const [entries, { refetch }] = createResource(result, (r) =>
    call("actionLog.list", r === "all" ? {} : { result: r }),
  )
  onCleanup(window.robot.on("actionLog.changed", () => void refetch()))

  const row = (e: ActionLogEntry) => (
    <li class={styles.logRow} data-testid="action-log-entry" data-outside={e.outside !== null}>
      <div class={styles.logHead}>
        <span class={styles.label}>{t(`permissions.log.kind.${e.kind}` as MessageKey)}</span>
        <span class={styles.logTag} data-result={e.result}>
          {t(`permissions.log.result.${e.result}` as MessageKey)}
        </span>
      </div>
      <div class={styles.logTarget}>{e.target}</div>
      <div class={styles.hint}>
        {[
          formatDateTime(app.locale(), e.at),
          e.agentName || t("permissions.log.deletedAgent"),
          t(`permissions.log.decided.${e.decidedBy}` as MessageKey),
        ].join(" · ")}
      </div>
      <div class={styles.hint} data-testid="action-log-outside">
        {e.outside
          ? t("permissions.log.outside", { source: outsideSourceText(t, e.outside) })
          : t("permissions.log.noOutside")}
      </div>
    </li>
  )

  return (
    <>
      <div class={styles.row}>
        <div>
          <div class={styles.label}>{t("permissions.log.title")}</div>
          <div class={`${styles.hint} ${styles.words}`}>{t("permissions.log.hint")}</div>
        </div>
        <Segmented
          label={t("permissions.log.filterResult")}
          testId="action-log-result"
          value={result()}
          onChange={setResult}
          options={RESULTS.map((r) => ({
            value: r,
            label:
              r === "all"
                ? t("permissions.log.allResults")
                : t(`permissions.log.result.${r}` as MessageKey),
          }))}
        />
      </div>
      <Show
        when={(entries.latest ?? []).length > 0}
        fallback={<p class={styles.muted}>{t("permissions.log.empty")}</p>}
      >
        <ul class={styles.log} data-testid="action-log">
          <For each={entries.latest ?? []}>{row}</For>
        </ul>
      </Show>
    </>
  )
}
