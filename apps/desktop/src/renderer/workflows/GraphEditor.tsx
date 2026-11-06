import {
  type GraphProblem,
  type GraphVersion,
  graphProblems,
  type MessageKey,
  type ModelChoice,
  NODES_MAX,
  type NodeKind,
  THRESHOLD_DEFAULT,
  type WorkflowDetail,
  type WorkflowNode,
} from "@robot/shared"
import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { formatDateTime } from "../lib/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./graph.module.css"
import { NodePanel } from "./NodePanel.tsx"

const NODE_W = 176
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
  const [restored, setRestored] = createSignal(false)
  return (
    <section class={styles.versionsBox} aria-label={t("graph.versions")}>
      <h3>{t("graph.versions")}</h3>
      <p class={styles.hintText}>{t("graph.versions.hint")}</p>
      <Show
        when={(versions() ?? []).length > 0}
        fallback={<p class={styles.hintText}>{t("graph.versions.empty")}</p>}
      >
        <ul class={styles.list}>
          <For each={versions()}>
            {(v) => (
              <li class={styles.listRow} data-testid="graph-version">
                <span>
                  {formatDateTime(locale(), v.createdAt)}{" "}
                  <span class={styles.hintText}>
                    {t(`graph.version.source.${v.source}` as MessageKey)} ·{" "}
                    {t("graph.version.row", {
                      nodes: v.graph.nodes.length,
                      connections: v.graph.connections.length,
                    })}
                  </span>
                </span>
                <Button
                  disabled={props.readOnly}
                  data-testid="graph-version-restore"
                  onClick={() => {
                    setProblem(undefined)
                    call("workflows.versions.restore", { id: props.workflow.id, versionId: v.id })
                      .then(() => setRestored(true))
                      .catch((e) => setProblem(describeError(e)))
                  }}
                >
                  {t("graph.version.restore")}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={restored()}>
        <p class={styles.hintText} role="status" data-testid="graph-restored">
          {t("graph.version.restored")}
        </p>
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
 * The editor of the graph (spec 010, flow 2). The canvas shows each node as a button at its place
 * and each connection as a line. A node moves with the pointer or with the arrow keys; it
 * connects through its side panel, so the whole editor works with the keyboard. The editor shows
 * the structural problems of the graph. The check on the TLA form is not part of it.
 */
export const GraphEditor = (props: { workflow: WorkflowDetail }) => {
  const { t } = useApp()
  const ui = useUi()
  const [selected, setSelected] = createSignal<string>()
  const [dragging, setDragging] = createSignal<{ id: string; x: number; y: number }>()
  const [showVersions, setShowVersions] = createSignal(false)
  const [problem, setProblem] = createSignal<ErrorText>()
  const [choices, { refetch }] = createResource(
    (): Promise<readonly ModelChoice[]> => call("models.available").catch(() => []),
  )
  onCleanup(window.robot.on("providers.changed", () => void refetch()))
  const graph = () => props.workflow.graph
  const readOnly = () => props.workflow.running
  const problems = createMemo(() => graphProblems(graph()))
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
    return { w, h }
  })

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
      setSelected(made.id)
    } catch (e) {
      setProblem(describeError(e))
    }
  }
  const move = (n: WorkflowNode, x: number, y: number) =>
    call("workflows.node.move", {
      id: n.id,
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
    }).catch((e) => setProblem(describeError(e)))

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

  const problemText = (p: GraphProblem) => {
    if (p.code === "nodes_full") return t("graph.problem.nodes_full", { max: NODES_MAX })
    const n = graph().nodes.find((x) => x.id === p.nodeId)
    if (!n) return ""
    if (p.code === "decision_options")
      return t("graph.problem.decision_options", { number: n.number, name: n.name })
    return t("graph.problem.option_unconnected", {
      number: n.number,
      name: n.name,
      option: n.options.find((o) => o.id === p.optionId)?.label ?? "",
    })
  }
  const hasProblem = (n: WorkflowNode) => problems().some((p) => "nodeId" in p && p.nodeId === n.id)

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

  return (
    <div class={styles.layout} data-narrow={ui.narrow()} data-testid="graph-editor">
      <div class={styles.main}>
        <Show when={readOnly()}>
          <p class={styles.panel} role="status" data-testid="graph-readonly">
            {t("graph.readonly")}
          </p>
        </Show>
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
            onClick={() => setShowVersions(!showVersions())}
            aria-pressed={showVersions()}
            data-testid="graph-versions-toggle"
          >
            {showVersions() ? t("graph.version.hide") : t("graph.version.show")}
          </Button>
        </div>
        <Show when={problem()}>
          {(p) => (
            <p class={styles.errorText} role="alert" data-testid="graph-error">
              {t(p().key, p().params)}
            </p>
          )}
        </Show>
        <Show when={problems().length > 0}>
          <section aria-label={t("graph.problems")}>
            <ul class={styles.problems} data-testid="graph-problems">
              <For each={problems()}>{(p) => <li>{problemText(p)}</li>}</For>
            </ul>
          </section>
        </Show>
        <section class={styles.canvas} aria-label={t("graph.canvas")} data-testid="graph-canvas">
          <Show
            when={graph().nodes.length > 0}
            fallback={
              <p class={styles.hintText} style={{ padding: "16px" }} data-testid="graph-empty">
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
                <For each={graph().connections}>
                  {(c) => {
                    const from = () => graph().nodes.find((n) => n.id === c.from)
                    const to = () => graph().nodes.find((n) => n.id === c.to)
                    const label = () => from()?.options.find((o) => o.id === c.optionId)?.label
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
                </For>
              </svg>
              <For each={graph().nodes}>
                {(n) => (
                  <button
                    type="button"
                    class={styles.node}
                    data-kind={n.kind}
                    data-problem={hasProblem(n)}
                    data-testid="graph-node"
                    aria-label={t("graph.node.aria", { number: n.number, name: n.name })}
                    aria-pressed={selected() === n.id}
                    style={{
                      left: `${positionOf(n).x}px`,
                      top: `${positionOf(n).y}px`,
                      width: `${NODE_W}px`,
                      height: `${NODE_H}px`,
                    }}
                    onClick={() => setSelected(n.id)}
                    onPointerDown={(e) => onPointerDown(n, e)}
                    onKeyDown={(e) => onKeyDown(n, e)}
                  >
                    <span class={styles.nodeName}>
                      {n.number}. {n.name}
                    </span>
                    <span class={styles.nodeKind}>
                      {t(n.kind === "text" ? "graph.kind.text" : "graph.kind.decision")}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </section>
        <Show when={showVersions()}>
          <Versions workflow={props.workflow} readOnly={readOnly()} />
        </Show>
      </div>
      <div>
        <Show
          when={selected()}
          keyed
          fallback={<p class={styles.hintText}>{t("graph.panel.empty")}</p>}
        >
          {(id) => (
            <Show when={graph().nodes.find((x) => x.id === id)}>
              {(n) => (
                <NodePanel
                  workflow={props.workflow}
                  node={n()}
                  choices={choices() ?? []}
                  readOnly={readOnly()}
                  onDeleted={() => setSelected(undefined)}
                />
              )}
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}
