import {
  type GraphVersion,
  type MessageKey,
  type ModelChoice,
  type NodeKind,
  THRESHOLD_DEFAULT,
  type WorkflowDetail,
  type WorkflowNode,
} from "@robot/shared"
import {
  ChevronDown,
  ChevronUp,
  FileText,
  History,
  Minus,
  Plus,
  Split,
  TriangleAlert,
  X,
} from "lucide-solid"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
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
import { NodePanel } from "./NodePanel.tsx"

const NODE_W = 176
const NODE_H = 60
const STEP = 16
const GRID = 16
const ZOOM_MIN = 0.25
const ZOOM_MAX = 2

/**
 * The view of the canvas (spec 001): a point (px, py) of the graph shows at
 * (x + px * zoom, y + py * zoom) of the canvas. The canvas has no edge, so any x and y is valid.
 */
type View = { readonly x: number; readonly y: number; readonly zoom: number }
/** The graph starts below the floating buttons, so they never hide a node. */
const HOME: View = { x: 0, y: 64, zoom: 1 }
/** The space between the floats at the top of the canvas and the graph. */
const FLOAT_GAP = 24
const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
/** The view zoomed to `zoom`, with the point (cx, cy) of the canvas kept in place. */
const zoomAt = (v: View, zoom: number, cx: number, cy: number): View => {
  const z = clampZoom(zoom)
  return { x: cx - ((cx - v.x) * z) / v.zoom, y: cy - ((cy - v.y) * z) / v.zoom, zoom: z }
}

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
 * buttons, the versions, the zoom and the node panel float over it, and the node panel folds. The
 * canvas has no edge: it shows each node as a button at its place and each connection as a line,
 * in a view that pans and zooms freely. A drag on an empty part, one finger, or a two finger
 * scroll moves the view; a pinch or Ctrl with the wheel zooms it. A click there clears the
 * selection. A node moves with the pointer or with the arrow keys; it
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
  const [view, setView] = createSignal<View>(HOME)

  const add = async (kind: NodeKind) => {
    setProblem(undefined)
    try {
      const made = await call("workflows.node.add", {
        workflowId: props.workflow.id,
        node: {
          kind,
          name: t(kind === "text" ? "graph.node.new.text" : "graph.node.new.decision"),
          ...placeFor(graph().nodes.length),
          ...(kind === "decision"
            ? {
                threshold: THRESHOLD_DEFAULT,
                options: [t("graph.option.yes"), t("graph.option.no")],
              }
            : {}),
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
      const z = view().zoom
      setDragging({ id: n.id, x: Math.max(0, from.x + dx / z), y: Math.max(0, from.y + dy / z) })
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

  // On an empty part of the canvas, one pointer pans the view and two pointers pinch it; a click
  // clears the selection. The wheel pans, and with Ctrl or Cmd it zooms (a trackpad pinch).
  let canvasEl: HTMLElement | undefined
  const local = (clientX: number, clientY: number) => {
    const r = canvasEl?.getBoundingClientRect()
    return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) }
  }
  const pointers = new Map<number, { x: number; y: number }>()
  /** Where one pointer started to pan, and the view then: the pan follows the whole move. */
  let anchor: { x: number; y: number; view: View } | undefined
  let gestureMoved = false
  const spread = () => {
    const [a, b] = [...pointers.values()]
    return a && b
      ? { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      : undefined
  }
  const anchorAt = () => {
    const [only] = [...pointers.values()]
    anchor = pointers.size === 1 && only ? { ...only, view: view() } : undefined
  }
  const onCanvasPointerDown = (e: PointerEvent) => {
    const el = canvasEl
    if (!el || e.button !== 0 || (e.target as Element).closest("button, path, text")) return
    if (pointers.size === 0) gestureMoved = false
    pointers.set(e.pointerId, local(e.clientX, e.clientY))
    el.setPointerCapture(e.pointerId)
    anchorAt()
  }
  const onCanvasPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId) || !canvasEl) return
    const before = spread()
    const now = local(e.clientX, e.clientY)
    pointers.set(e.pointerId, now)
    const after = spread()
    if (before && after) {
      gestureMoved = true
      const v = zoomAt(view(), (view().zoom * after.d) / Math.max(1, before.d), before.x, before.y)
      setView({ ...v, x: v.x + after.x - before.x, y: v.y + after.y - before.y })
      return
    }
    if (!anchor) return
    const dx = now.x - anchor.x
    const dy = now.y - anchor.y
    if (!gestureMoved && Math.hypot(dx, dy) < 4) return
    gestureMoved = true
    canvasEl.dataset.panning = "true"
    setView({ ...anchor.view, x: anchor.view.x + dx, y: anchor.view.y + dy })
  }
  const onCanvasPointerUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return
    anchorAt()
    if (pointers.size > 0) return
    if (canvasEl) delete canvasEl.dataset.panning
    if (!gestureMoved && e.type === "pointerup") props.onSelectNode(undefined)
  }
  const zoomBy = (factor: number) => {
    const r = canvasEl?.getBoundingClientRect()
    setView((v) => zoomAt(v, v.zoom * factor, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2))
  }
  onMount(() => {
    const el = canvasEl
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      const dx = e.deltaX * unit
      const dy = e.deltaY * unit
      if (e.ctrlKey || e.metaKey) {
        const at = local(e.clientX, e.clientY)
        const step = Math.max(-50, Math.min(50, dy))
        setView((v) => zoomAt(v, v.zoom * Math.exp(-step * 0.01), at.x, at.y))
      } else {
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }))
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => el.removeEventListener("wheel", onWheel))
  })
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
  // The graph starts below everything that floats at the top (the toolbar, the read-only note,
  // an error, the versions): when the floats grow or shrink, the view moves by the same height.
  let floatEl: HTMLDivElement | undefined
  const [floatH, setFloatH] = createSignal(HOME.y - FLOAT_GAP)
  const home = (): View => ({ ...HOME, y: floatH() + FLOAT_GAP })
  onMount(() => {
    const el = floatEl
    if (!el) return
    const read = () => setFloatH(el.offsetHeight)
    read()
    const sizes = new ResizeObserver(read)
    sizes.observe(el)
    onCleanup(() => sizes.disconnect())
  })
  createEffect(
    on(floatH, (h, before) => {
      if (before !== undefined) setView((v) => ({ ...v, y: v.y + h - before }))
    }),
  )
  // When the panel opens, the selected node stays visible: the view pans it clear of the panel.
  // The panel keeps floating over the canvas (spec 001).
  let layoutEl: HTMLDivElement | undefined
  const clearNode = () => {
    const root = layoutEl
    if (!canvasEl || !root || !props.selectedNode) return
    const node = canvasEl.querySelector<HTMLElement>(
      '[data-testid="graph-node"][aria-pressed="true"]',
    )
    const panel = root.querySelector<HTMLElement>('[data-testid="node-side"]')
    if (!node || !panel) return
    const n = node.getBoundingClientRect()
    const p = panel.getBoundingClientRect()
    const x = Math.min(n.right, p.right) - Math.max(n.left, p.left)
    const y = Math.min(n.bottom, p.bottom) - Math.max(n.top, p.top)
    if (x <= 0 || y <= 0) return
    // The panel floats at the right: move the node to its left.
    setView((v) => ({ ...v, x: v.x - (x + 8) }))
  }
  let panelSizes: ResizeObserver | undefined
  onMount(() => {
    panelSizes = new ResizeObserver(() => clearNode())
    onCleanup(() => panelSizes?.disconnect())
  })
  createEffect(
    on(
      () => [props.selectedNode, ui.nodePanelFolded()] as const,
      () => {
        clearNode()
        // The panel grows as its content loads: keep the node clear then too.
        const panel = layoutEl?.querySelector<HTMLElement>('[data-testid="node-side"]')
        panelSizes?.disconnect()
        if (panel) panelSizes?.observe(panel)
      },
    ),
  )
  return (
    <div class={styles.layout} ref={layoutEl} data-narrow={ui.narrow()} data-testid="graph-editor">
      <div class={styles.canvasArea}>
        <section
          ref={canvasEl}
          class={styles.canvas}
          aria-label={t("graph.canvas")}
          data-testid="graph-canvas"
          style={{
            "background-size": `${GRID * view().zoom}px ${GRID * view().zoom}px`,
            "background-position": `${view().x}px ${view().y}px`,
          }}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={onCanvasPointerUp}
          onPointerCancel={onCanvasPointerUp}
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
              data-testid="graph-view"
              style={{
                transform: `translate(${view().x}px, ${view().y}px) scale(${view().zoom})`,
              }}
            >
              <svg
                class={styles.lines}
                width="1"
                height="1"
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
                    const label = () => from()?.options.find((o) => o.id === c().optionId)?.label
                    return (
                      <Show when={from() && to()}>
                        {(() => {
                          const l = () => lineFor(from() as WorkflowNode, to() as WorkflowNode)
                          return (
                            <g data-testid="graph-line">
                              <path
                                d={l().d}
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.5"
                                marker-end="url(#arrow)"
                              />
                              <Show when={label()}>
                                <text
                                  class={styles.lineLabel}
                                  x={(l().x1 + l().x2) / 2}
                                  y={(l().y1 + l().y2) / 2 - 6}
                                  text-anchor="middle"
                                >
                                  {label()}
                                </text>
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
                    <span class={styles.nodeHead}>
                      <span class={styles.nodeName}>
                        {node().number}. {node().name}
                      </span>
                      <Show when={working(node())}>
                        <span class={styles.nodeSpin} data-testid="graph-node-running">
                          <Spinner />
                        </span>
                      </Show>
                    </span>
                    <span class={styles.nodeKind} data-testid="graph-node-kind">
                      <Show
                        when={node().kind === "decision"}
                        fallback={<FileText size={12} aria-hidden="true" />}
                      >
                        <Split size={12} aria-hidden="true" />
                      </Show>
                      {t(node().kind === "text" ? "graph.kind.text" : "graph.kind.decision")}
                    </span>
                  </button>
                )}
              </Keyed>
            </div>
          </Show>
        </section>
        <div class={styles.float} ref={floatEl}>
          <div class={styles.toolbar} data-testid="graph-toolbar">
            <Button
              disabled={readOnly()}
              onClick={() => void add("text")}
              aria-label={t("graph.add.text")}
              data-testid="graph-add-text"
            >
              <FileText size={14} aria-hidden="true" />
              <span class={styles.toolbarLabel}>{t("graph.add.text")}</span>
            </Button>
            <Button
              disabled={readOnly()}
              onClick={() => void add("decision")}
              aria-label={t("graph.add.decision")}
              data-testid="graph-add-decision"
            >
              <Split size={14} aria-hidden="true" />
              <span class={styles.toolbarLabel}>{t("graph.add.decision")}</span>
            </Button>
            <Button
              onClick={() => setShowVersions(!showVersions())}
              aria-pressed={showVersions()}
              aria-label={showVersions() ? t("graph.version.hide") : t("graph.version.show")}
              data-testid="graph-versions-toggle"
            >
              <History size={14} aria-hidden="true" />
              <span class={styles.toolbarLabel}>
                {showVersions() ? t("graph.version.hide") : t("graph.version.show")}
              </span>
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
        <div class={styles.zoom} data-testid="graph-zoom">
          <IconButton
            label={t("graph.zoom.out")}
            onClick={() => zoomBy(1 / 1.25)}
            data-testid="graph-zoom-out"
          >
            <Minus size={14} />
          </IconButton>
          <button
            type="button"
            class={styles.zoomValue}
            title={t("graph.zoom.reset")}
            aria-label={`${t("graph.zoom")} ${Math.round(view().zoom * 100)}%. ${t("graph.zoom.reset")}`}
            onClick={() => setView(home())}
            data-testid="graph-zoom-reset"
          >
            {Math.round(view().zoom * 100)}%
          </button>
          <IconButton
            label={t("graph.zoom.in")}
            onClick={() => zoomBy(1.25)}
            data-testid="graph-zoom-in"
          >
            <Plus size={14} />
          </IconButton>
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
                <div
                  class={styles.sideBody}
                  hidden={ui.nodePanelFolded()}
                  data-testid="node-side-body"
                >
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
