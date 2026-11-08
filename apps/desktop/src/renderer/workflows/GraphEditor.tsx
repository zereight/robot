import {
  type GraphVersion,
  type MessageKey,
  type ModelChoice,
  type NodeKind,
  THRESHOLD_DEFAULT,
  type WorkflowDetail,
  type WorkflowNode,
} from "@robot/shared"
import { ChevronDown, ChevronUp, FileText, Split, Stamp, TriangleAlert, X } from "lucide-solid"
import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { formatDateTime } from "../lib/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import { Spinner } from "../ui/Spinner.tsx"
import { showToast } from "../ui/toast.ts"
import { marksOf } from "./checkView.ts"
import styles from "./graph.module.css"
import { labelPlace } from "./labelPlace.ts"
import { approvalOutputKey, nodeKindKey } from "./labels.ts"
import { NodePanel } from "./NodePanel.tsx"

const NODE_W = 176
/** The width of the node panel and its margins: the canvas scrolls that far past the graph. */
const PANEL_ROOM = 352
const NODE_H = 60
const STEP = 16

/** A place for a new node: a grid of four columns, in the order of the numbers. */
const placeFor = (count: number) => ({
  x: 24 + (count % 4) * (NODE_W + 40),
  y: 24 + Math.floor(count / 4) * (NODE_H + 60),
})

/** The versions of the graph (spec 010, flow 4): open the list, restore one. */
const Versions = (props: { workflow: WorkflowDetail; readOnly: boolean }) => {
  const { t, locale } = useApp()
  const [versions, { refetch }] = createResource(
    () => props.workflow.id,
    (id): Promise<readonly GraphVersion[]> => call("workflows.versions", { id }).catch(() => []),
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  const [problem, setProblem] = createSignal<ErrorText>()
  return (
    <section class={styles.versionsBox} aria-label={t("graph.versions")}>
      <h3>{t("graph.versions")}</h3>
      <p class={styles.hintText}>{t("graph.versions.hint")}</p>
      <Show
        when={(versions() ?? []).length > 0}
        fallback={<p class={styles.hintText}>{t("graph.versions.empty")}</p>}
      >
        <ul class={styles.list}>
          <Keyed each={versions()} by={(x) => x.id}>
            {(version) => (
              <li class={styles.listRow} data-testid="graph-version">
                <span>
                  {formatDateTime(locale(), version().createdAt)}{" "}
                  <span class={styles.hintText}>
                    {t(`graph.version.source.${version().source}` as MessageKey)} ·{" "}
                    {t("graph.version.row", {
                      nodes: version().graph.nodes.length,
                      connections: version().graph.connections.length,
                    })}
                  </span>
                </span>
                <Button
                  disabled={props.readOnly}
                  data-testid="graph-version-restore"
                  onClick={() => {
                    setProblem(undefined)
                    call("workflows.versions.restore", {
                      id: props.workflow.id,
                      versionId: version().id,
                    })
                      .then(() => showToast("success", "graph.version.restored"))
                      .catch((e) => setProblem(describeError(e)))
                  }}
                >
                  {t("graph.version.restore")}
                </Button>
              </li>
            )}
          </Keyed>
        </ul>
      </Show>
      <Show when={problem()}>
        {(p) => (
          <p class={styles.errorText} role="alert">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>
    </section>
  )
}

/**
 * The editor of the graph (spec 010, flow 2). The canvas fills the workflow view (spec 001); the
 * buttons, the versions and the node panel float over it, and the node panel folds. The
 * canvas shows each node as a button at its place and each connection as a line. A drag on an
 * empty part moves the view; a click there clears the selection. A node moves with the pointer or with the arrow keys; it
 * connects through its side panel, so the whole editor works with the keyboard. The canvas marks
 * the nodes of the problem and of its path while the run strip shows the check (spec 001).
 */
export const GraphEditor = (props: {
  workflow: WorkflowDetail
  /** The numbers of the nodes that work now: each shows a spinner (specs/039). */
  runningNodes?: ReadonlySet<number>
  /** The selected node. The run strip selects a node too, from the path of the check. */
  selectedNode: string | undefined
  onSelectNode: (id: string | undefined) => void
  /** The run strip shows the check: the canvas marks the nodes of the problem and its path. */
  showCheck: boolean
}) => {
  const { t } = useApp()
  const ui = useUi()
  const [dragging, setDragging] = createSignal<{ id: string; x: number; y: number }>()
  const [showVersions, setShowVersions] = createSignal(false)
  const [problem, setProblem] = createSignal<ErrorText>()
  const [choices, { refetch }] = createResource(
    (): Promise<readonly ModelChoice[]> => call("models.available").catch(() => []),
  )
  onCleanup(window.robot.on("providers.changed", () => void refetch()))
  const graph = () => props.workflow.graph
  const readOnly = () => props.workflow.running
  const marks = createMemo(() => marksOf(props.showCheck ? props.workflow.checkOutcome : null))
  const positionOf = (n: WorkflowNode) => {
    const d = dragging()
    return d && d.id === n.id ? { x: d.x, y: d.y } : { x: n.x, y: n.y }
  }
  const extent = createMemo(() => {
    let w = 640
    let h = 360
    for (const n of graph().nodes) {
      const p = positionOf(n)
      w = Math.max(w, p.x + NODE_W + 48)
      h = Math.max(h, p.y + NODE_H + 48)
    }
    // An open node panel floats over the right side; the room lets the user pan a node out from
    // under it.
    if (props.selectedNode && !ui.nodePanelFolded()) w += PANEL_ROOM
    return { w, h }
  })

  const add = async (kind: NodeKind) => {
    setProblem(undefined)
    try {
      const made = await call("workflows.node.add", {
        workflowId: props.workflow.id,
        node: {
          kind,
          name:
            kind === "text"
              ? t("graph.node.new.text")
              : kind === "decision"
                ? t("graph.node.new.decision")
                : t("graph.node.new.approval"),
          ...placeFor(graph().nodes.length),
          ...(kind === "decision"
            ? {
                threshold: THRESHOLD_DEFAULT,
                options: [t("graph.option.yes"), t("graph.option.no")],
              }
            : {}),
          ...(kind === "approval" ? { question: t("graph.node.new.approval.question") } : {}),
        },
      })
      showToast("success", "workflows.saved")
      props.onSelectNode(made.id)
    } catch (e) {
      setProblem(describeError(e))
    }
  }
  const move = (n: WorkflowNode, x: number, y: number) =>
    call("workflows.node.move", {
      id: n.id,
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
    })
      .then(() => showToast("success", "workflows.saved"))
      .catch((e) => setProblem(describeError(e)))

  const onPointerDown = (n: WorkflowNode, e: PointerEvent) => {
    if (readOnly() || e.button !== 0) return
    const target = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    const from = { x: n.x, y: n.y }
    let moved = false
    target.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      setDragging({ id: n.id, x: Math.max(0, from.x + dx), y: Math.max(0, from.y + dy) })
    }
    const onUp = () => {
      target.removeEventListener("pointermove", onMove)
      target.removeEventListener("pointerup", onUp)
      target.removeEventListener("pointercancel", onUp)
      const d = dragging()
      setDragging(undefined)
      if (moved && d) void move(n, d.x, d.y)
    }
    target.addEventListener("pointermove", onMove)
    target.addEventListener("pointerup", onUp)
    target.addEventListener("pointercancel", onUp)
  }
  const onKeyDown = (n: WorkflowNode, e: KeyboardEvent) => {
    if (readOnly() || !e.altKey) return
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-STEP, 0],
      ArrowRight: [STEP, 0],
      ArrowUp: [0, -STEP],
      ArrowDown: [0, STEP],
    }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    void move(n, n.x + d[0], n.y + d[1])
  }

  const hasProblem = (n: WorkflowNode) => marks().faults.has(n.id)
  const working = (n: WorkflowNode) => props.runningNodes?.has(n.number) === true
  /** What a screen reader says for a node: the node, and its mark when the check marks it. */
  const nodeLabel = (n: WorkflowNode) => {
    const line = marks().lines.get(n.id)
    return [
      t("graph.node.aria", { number: n.number, name: n.name }),
      ...(working(n) ? [t("workflows.run.state.running")] : []),
      ...(line === undefined ? [] : [t("check.marked", { line })]),
      ...(hasProblem(n) ? [t("check.marked.problem", { line: line ?? 0 })] : []),
    ].join(". ")
  }

  const lineFor = (from: WorkflowNode, to: WorkflowNode) => {
    const a = positionOf(from)
    const b = positionOf(to)
    const x1 = a.x + NODE_W
    const y1 = a.y + NODE_H / 2
    const x2 = b.x
    const y2 = b.y + NODE_H / 2
    const bend = Math.max(40, Math.abs(x2 - x1) / 2)
    return {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      x1,
      y1,
      x2,
      y2,
    }
  }

  // A drag on an empty part of the canvas moves the view; a click there clears the selection.
  let canvasEl: HTMLElement | undefined
  const onCanvasPointerDown = (e: PointerEvent) => {
    const el = canvasEl
    if (!el || e.button !== 0 || (e.target as Element).closest("button, path, text")) return
    const startX = e.clientX
    const startY = e.clientY
    const from = { left: el.scrollLeft, top: el.scrollTop }
    let moved = false
    el.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!moved && Math.hypot(dx, dy) < 4) return
      moved = true
      el.dataset.panning = "true"
      el.scrollLeft = from.left - dx
      el.scrollTop = from.top - dy
    }
    const onUp = () => {
      el.removeEventListener("pointermove", onMove)
      el.removeEventListener("pointerup", onUp)
      el.removeEventListener("pointercancel", onUp)
      delete el.dataset.panning
      if (!moved) props.onSelectNode(undefined)
    }
    el.addEventListener("pointermove", onMove)
    el.addEventListener("pointerup", onUp)
    el.addEventListener("pointercancel", onUp)
  }
  // Escape closes the node panel (spec 001), unless a field of the panel has the focus.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !props.selectedNode || e.defaultPrevented) return
      const target = e.target as Element | null
      if (target?.closest("input, textarea, select, [role=dialog], [data-confirm]")) return
      props.onSelectNode(undefined)
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })
  return (
    <div class={styles.layout} data-narrow={ui.narrow()} data-testid="graph-editor">
      <div class={styles.canvasArea}>
        <section
          ref={canvasEl}
          class={styles.canvas}
          aria-label={t("graph.canvas")}
          data-testid="graph-canvas"
          onPointerDown={onCanvasPointerDown}
        >
          <Show
            when={graph().nodes.length > 0}
            fallback={
              <p class={styles.canvasEmpty} data-testid="graph-empty">
                {t("graph.empty")}
              </p>
            }
          >
            <div
              class={styles.canvasInner}
              style={{ width: `${extent().w}px`, height: `${extent().h}px` }}
            >
              <svg
                class={styles.lines}
                width={extent().w}
                height={extent().h}
                aria-hidden="true"
                data-testid="graph-lines"
              >
                <defs>
                  <marker
                    id="arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                  </marker>
                </defs>
                <Keyed each={graph().connections} by={(c) => c.id}>
                  {(c) => {
                    const from = () => graph().nodes.find((n) => n.id === c().from)
                    const to = () => graph().nodes.find((n) => n.id === c().to)
                    const label = () => {
                      const f = from()
                      const s = c().source
                      if (s.kind === "verdict") return t(approvalOutputKey(s.verdict))
                      if (s.kind !== "option" || f?.kind !== "decision") return undefined
                      return f.options.find((o) => o.id === s.optionId)?.label
                    }
                    return (
                      <Show when={from() && to()}>
                        {(() => {
                          const l = () => lineFor(from() as WorkflowNode, to() as WorkflowNode)
                          const at = () => {
                            const text = label()
                            if (text === undefined) return undefined
                            const p = (n: WorkflowNode) => {
                              const q = positionOf(n)
                              return { x: q.x, y: q.y, w: NODE_W, h: NODE_H }
                            }
                            return labelPlace(l(), text, graph().nodes.map(p))
                          }
                          return (
                            <g data-testid="graph-line">
                              <path
                                d={l().d}
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.5"
                                marker-end="url(#arrow)"
                              />
                              <Show when={at()}>
                                {(p) => (
                                  <text
                                    class={styles.lineLabel}
                                    x={p().x}
                                    y={p().y}
                                    text-anchor="middle"
                                  >
                                    {label()}
                                  </text>
                                )}
                              </Show>
                            </g>
                          )
                        })()}
                      </Show>
                    )
                  }}
                </Keyed>
              </svg>
              <Keyed each={graph().nodes} by={(x) => x.id}>
                {(node) => (
                  <button
                    type="button"
                    class={styles.node}
                    data-kind={node().kind}
                    data-problem={hasProblem(node())}
                    data-running={working(node())}
                    data-testid="graph-node"
                    aria-label={nodeLabel(node())}
                    aria-pressed={props.selectedNode === node().id}
                    style={{
                      left: `${positionOf(node()).x}px`,
                      top: `${positionOf(node()).y}px`,
                      width: `${NODE_W}px`,
                      height: `${NODE_H}px`,
                    }}
                    onClick={() => props.onSelectNode(node().id)}
                    onPointerDown={(e) => onPointerDown(node(), e)}
                    onKeyDown={(e) => onKeyDown(node(), e)}
                  >
                    <Show when={marks().lines.get(node().id) !== undefined || hasProblem(node())}>
                      <span
                        class={styles.mark}
                        data-problem={hasProblem(node())}
                        data-testid="graph-node-mark"
                        aria-hidden="true"
                        title={t(hasProblem(node()) ? "check.marked.problem" : "check.marked", {
                          line: marks().lines.get(node().id) ?? 0,
                        })}
                      >
                        <Show when={hasProblem(node())}>
                          <TriangleAlert size={12} aria-hidden="true" />
                        </Show>
                        {marks().lines.get(node().id)}
                      </span>
                    </Show>
                    <span class={styles.nodeName}>
                      {node().number}. {node().name}
                    </span>
                    <Show when={working(node())}>
                      <span class={styles.nodeSpin} data-testid="graph-node-running">
                        <Spinner />
                      </span>
                    </Show>
                    <span class={styles.nodeKind} data-testid="graph-node-kind">
                      <Show
                        when={node().kind === "decision"}
                        fallback={
                          <Show
                            when={node().kind === "approval"}
                            fallback={<FileText size={12} aria-hidden="true" />}
                          >
                            <Stamp size={12} aria-hidden="true" />
                          </Show>
                        }
                      >
                        <Split size={12} aria-hidden="true" />
                      </Show>
                      {t(nodeKindKey(node().kind))}
                    </span>
                  </button>
                )}
              </Keyed>
            </div>
          </Show>
        </section>
        <div class={styles.float}>
          <div class={styles.toolbar}>
            <Button
              disabled={readOnly()}
              onClick={() => void add("text")}
              data-testid="graph-add-text"
            >
              {t("graph.add.text")}
            </Button>
            <Button
              disabled={readOnly()}
              onClick={() => void add("decision")}
              data-testid="graph-add-decision"
            >
              {t("graph.add.decision")}
            </Button>
            <Button
              disabled={readOnly()}
              onClick={() => void add("approval")}
              data-testid="graph-add-approval"
            >
              {t("graph.add.approval")}
            </Button>
            <Button
              onClick={() => setShowVersions(!showVersions())}
              aria-pressed={showVersions()}
              data-testid="graph-versions-toggle"
            >
              {showVersions() ? t("graph.version.hide") : t("graph.version.show")}
            </Button>
          </div>
          <Show when={readOnly()}>
            <p class={styles.floatNote} role="status" data-testid="graph-readonly">
              {t("graph.readonly")}
            </p>
          </Show>
          <Show when={problem()}>
            {(p) => (
              <p
                class={`${styles.floatNote} ${styles.errorText}`}
                role="alert"
                data-testid="graph-error"
              >
                {t(p().key, p().params)}
              </p>
            )}
          </Show>
          <Show when={showVersions()}>
            <Versions workflow={props.workflow} readOnly={readOnly()} />
          </Show>
        </div>
        <Show when={!props.selectedNode && graph().nodes.length > 0}>
          <p class={styles.canvasHint}>{t("graph.panel.empty")}</p>
        </Show>
      </div>
      <Show when={props.selectedNode} keyed>
        {(id) => (
          <Show when={graph().nodes.find((x) => x.id === id)}>
            {(n) => (
              <div class={styles.side} data-folded={ui.nodePanelFolded()} data-testid="node-side">
                <div class={styles.sideHead}>
                  <span class={styles.sideTitle} data-testid="node-side-title">
                    {n().number}. {n().name}
                  </span>
                  <IconButton
                    label={ui.nodePanelFolded() ? t("graph.panel.unfold") : t("graph.panel.fold")}
                    aria-expanded={!ui.nodePanelFolded()}
                    onClick={() => ui.selectNodePanelFolded(!ui.nodePanelFolded())}
                    data-testid="node-panel-fold"
                  >
                    {ui.nodePanelFolded() ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                  </IconButton>
                  <IconButton
                    label={t("graph.panel.close")}
                    onClick={() => props.onSelectNode(undefined)}
                    data-testid="node-panel-close"
                  >
                    <X size={16} />
                  </IconButton>
                </div>
                <div class={styles.sideBody} hidden={ui.nodePanelFolded()}>
                  <NodePanel
                    workflow={props.workflow}
                    node={n()}
                    choices={choices() ?? []}
                    readOnly={readOnly()}
                    onDeleted={() => props.onSelectNode(undefined)}
                  />
                </div>
              </div>
            )}
          </Show>
        )}
      </Show>
    </div>
  )
}
