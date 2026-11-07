import {
  CHECK_STATES_MAX,
  CHECK_TIME_MS,
  type CheckOutcome,
  type CheckProblem,
  type CheckStep,
  checkStateOf,
  type GraphProblem,
  type MessageKey,
  NODES_MAX,
  problemPath,
  type WorkflowDetail,
  type WorkflowNode,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { problemsOf } from "./checkView.ts"
import styles from "./graph.module.css"

/**
 * The panel of the check (spec 010, "Check"): the state, the list of problems, and for the first
 * problem the path to it as a numbered list. A click on a line selects its node. The button
 * "Check" runs the check of the saved graph again.
 */
export const CheckPanel = (props: {
  workflow: WorkflowDetail
  onSelect: (nodeId: string) => void
  onClose: () => void
}) => {
  const { t, locale } = useApp()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const graph = () => props.workflow.graph
  const outcome = (): CheckOutcome | null => props.workflow.checkOutcome
  const nodeOf = (id: string): WorkflowNode | undefined => graph().nodes.find((n) => n.id === id)
  const nodeText = (id: string) => {
    const n = nodeOf(id)
    return n ? t("check.node", { number: n.number, name: n.name }) : ""
  }

  const graphText = (p: GraphProblem) => {
    if (p.code === "nodes_full") return t("graph.problem.nodes_full", { max: NODES_MAX })
    const n = nodeOf(p.nodeId)
    if (!n) return ""
    if (p.code === "decision_options")
      return t("graph.problem.decision_options", { number: n.number, name: n.name })
    return t("graph.problem.option_unconnected", {
      number: n.number,
      name: n.name,
      option: n.options.find((o) => o.id === p.optionId)?.label ?? "",
    })
  }
  const problemText = (p: CheckProblem) => {
    if (p.code === "deadlock")
      return t("check.problem.deadlock", { nodes: p.nodeIds.map(nodeText).join(", ") })
    if (p.code === "never_runs") {
      const n = nodeOf(p.nodeIds[0] ?? "")
      return n ? t("check.problem.never_runs", { number: n.number, name: n.name }) : ""
    }
    return graphText(p)
  }
  const stepText = (s: CheckStep) => {
    const n = nodeOf(s.nodeId)
    if (!n) return ""
    const base = { number: n.number, name: n.name }
    if (s.event === "skipped") return t("check.step.skipped", base)
    const option = n.options.find((o) => o.id === s.optionId)?.label
    return option === undefined
      ? t("check.step.ran", base)
      : t("check.step.option", { ...base, option })
  }
  const stoppedText = (reason: "time" | "states" | "memory") => {
    const key = `check.stopped.${reason}` as MessageKey
    return t(key, {
      seconds: CHECK_TIME_MS / 1000,
      states: new Intl.NumberFormat(locale()).format(CHECK_STATES_MAX),
    })
  }

  const run = () => {
    setBusy(true)
    setFailure(undefined)
    call("workflows.check", { id: props.workflow.id })
      .catch((e) => {
        const text = describeError(e)
        setFailure(t(text.key, text.params))
      })
      .finally(() => setBusy(false))
  }

  const first = () => problemsOf(outcome())[0]
  const stopped = () => {
    const o = outcome()
    return o?.state === "stopped" ? o : undefined
  }
  const failed = () => {
    const o = outcome()
    return o?.state === "failed" ? o : undefined
  }
  return (
    <section class={styles.checkPanel} aria-label={t("check.heading")} data-testid="check-panel">
      <div class={styles.checkHead}>
        <h3>{t("check.heading")}</h3>
        <span data-testid="check-state" data-state={outcome()?.state ?? "not_checked"}>
          {t(`workflows.check.${checkStateOf(outcome())}` as MessageKey)}
        </span>
        <span class={styles.headSpacer} />
        <Button onClick={run} disabled={busy()} aria-busy={busy()} data-testid="graph-check">
          {t("check.run")}
        </Button>
        <Button onClick={props.onClose} data-testid="check-close">
          {t("check.close")}
        </Button>
      </div>
      <Show when={failure()}>
        {(text) => (
          <p class={styles.errorText} role="alert">
            {text()}
          </p>
        )}
      </Show>
      {/* One live region that stays in the page, so that a screen reader says each new result. */}
      <div role="status" data-testid="check-status">
        <Show when={outcome()?.state === "passed"}>
          <p data-testid="check-passed">{t("check.state.passed")}</p>
        </Show>
        <Show when={outcome() === null}>
          <p class={styles.hintText} data-testid="check-not-checked">
            {t("check.state.not_checked")}
          </p>
        </Show>
        <Show when={problemsOf(outcome()).length > 0}>
          <p data-testid="check-problem-found">{t("workflows.check.problem")}</p>
        </Show>
        <Show when={stopped()}>
          {(o) => <p data-testid="check-stopped">{stoppedText(o().reason)}</p>}
        </Show>
      </div>
      <Show when={failed()}>
        <p role="alert" data-testid="check-failed">
          {t("check.failed")}
        </p>
      </Show>
      <Show when={problemsOf(outcome()).length > 0}>
        <ul class={styles.problems} aria-label={t("graph.problems")} data-testid="graph-problems">
          <For each={problemsOf(outcome())}>{(p) => <li>{problemText(p)}</li>}</For>
        </ul>
        <Show when={first()}>
          {(p) => (
            <Show when={problemPath(p()).length > 0}>
              <div>
                <h4>{t("check.path")}</h4>
                <ol class={styles.pathList} data-testid="check-path">
                  <For each={problemPath(p())}>
                    {(step) => (
                      <li>
                        <button
                          type="button"
                          class={styles.pathLine}
                          data-testid="check-path-line"
                          onClick={() => props.onSelect(step.nodeId)}
                        >
                          {stepText(step)}
                        </button>
                      </li>
                    )}
                  </For>
                </ol>
              </div>
            </Show>
          )}
        </Show>
      </Show>
      <p class={styles.hintText}>{t("check.scope")}</p>
    </section>
  )
}
