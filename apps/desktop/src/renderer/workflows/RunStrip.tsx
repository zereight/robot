import { clampStripHeight, type RunSummary, type WorkflowDetail } from "@robot/shared"
import { ChevronDown, ChevronUp } from "lucide-solid"
import { createSignal, Match, Show, Switch } from "solid-js"
import { useApp } from "../state/app.tsx"
import { IconButton } from "../ui/controls.tsx"
import { tabKeyDown } from "../ui/tabKeys.ts"
import { CheckPanel } from "./CheckPanel.tsx"
import { RunsPanel } from "./RunsPanel.tsx"
import styles from "./workflows.module.css"

export type StripMode = "runs" | "check"

/**
 * The run strip (spec 001): the runs of the open workflow, or the result of the check. A close
 * button on the check returns to the runs. The strip folds to its tab row, so the canvas gets the
 * height; a press on a tab unfolds it. The user drags the top edge, or moves it with the arrow
 * keys, to change the height.
 */
export const RunStrip = (props: {
  workflow: WorkflowDetail
  runs: readonly RunSummary[]
  selected: string | undefined
  onSelect: (id: string | undefined) => void
  trigger: string
  onTrigger: (text: string) => void
  mode: StripMode
  onMode: (mode: StripMode) => void
  onSelectNode: (nodeId: string) => void
  folded: boolean
  onFold: (folded: boolean) => void
  height: number
  onHeight: (height: number) => void
}) => {
  const { t } = useApp()
  let stripEl: HTMLElement | undefined
  /** The height while the user drags the edge; it saves when the drag ends. */
  const [dragHeight, setDragHeight] = createSignal<number>()
  const viewHeight = () => stripEl?.parentElement?.clientHeight ?? Number.POSITIVE_INFINITY
  const height = () => clampStripHeight(dragHeight() ?? props.height, viewHeight())
  const onEdgeDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const edge = e.currentTarget as HTMLElement
    const startY = e.clientY
    const from = height()
    edge.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) =>
      setDragHeight(clampStripHeight(from + startY - ev.clientY, viewHeight()))
    const onUp = () => {
      edge.removeEventListener("pointermove", onMove)
      edge.removeEventListener("pointerup", onUp)
      edge.removeEventListener("pointercancel", onUp)
      const h = dragHeight()
      setDragHeight(undefined)
      if (h !== undefined) props.onHeight(h)
    }
    edge.addEventListener("pointermove", onMove)
    edge.addEventListener("pointerup", onUp)
    edge.addEventListener("pointercancel", onUp)
  }
  const onEdgeKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16
    const delta = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0
    if (!delta) return
    e.preventDefault()
    props.onHeight(clampStripHeight(height() + delta, viewHeight()))
  }
  const modes: readonly StripMode[] = ["runs", "check"]
  const label = (mode: StripMode) => (mode === "runs" ? t("runs.title") : t("check.heading"))
  return (
    <section
      ref={stripEl}
      class={styles.strip}
      style={props.folded ? {} : { height: `${height()}px` }}
      aria-label={t("runs.title")}
      data-testid="run-strip"
      data-mode={props.mode}
      data-folded={props.folded}
    >
      <Show when={!props.folded}>
        <hr
          tabIndex={0}
          class={styles.stripEdge}
          aria-orientation="horizontal"
          aria-label={t("runs.strip.resize")}
          aria-valuenow={height()}
          data-dragging={dragHeight() !== undefined}
          data-testid="strip-resize"
          onPointerDown={onEdgeDown}
          onKeyDown={onEdgeKey}
        />
      </Show>
      <div class={styles.stripTabs} role="tablist" aria-label={t("runs.title")}>
        {modes.map((mode) => (
          <button
            type="button"
            role="tab"
            class={styles.stripTab}
            aria-selected={props.mode === mode}
            tabIndex={props.mode === mode ? 0 : -1}
            data-testid={`strip-tab-${mode}`}
            onClick={() => props.onMode(mode)}
            onKeyDown={(e) => tabKeyDown(e, modes, props.mode, props.onMode)}
          >
            {label(mode)}
          </button>
        ))}
        <span class={styles.stripFold}>
          <IconButton
            label={props.folded ? t("runs.strip.unfold") : t("runs.strip.fold")}
            aria-expanded={!props.folded}
            onClick={() => props.onFold(!props.folded)}
            data-testid="strip-fold"
          >
            {props.folded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </IconButton>
        </span>
      </div>
      <Show when={!props.folded}>
        <div class={styles.stripBody} data-testid="strip-body">
          <Switch>
            <Match when={props.mode === "runs"}>
              <RunsPanel
                workflowId={props.workflow.id}
                runs={props.runs}
                selected={props.selected}
                onSelect={props.onSelect}
                trigger={props.trigger}
                onTrigger={props.onTrigger}
              />
            </Match>
            <Match when={props.mode === "check"}>
              <CheckPanel
                workflow={props.workflow}
                onSelect={props.onSelectNode}
                onClose={() => props.onMode("runs")}
              />
            </Match>
          </Switch>
        </div>
      </Show>
    </section>
  )
}
