import {
  type AgentState,
  buildOrgList,
  type ChartAgent,
  type ChartModel,
  type ChartOrg,
  copyKey,
  litBy,
  NO_ORG_KEY,
  orgSearchEmpty,
  orgSearchHits,
  ROOT_KEY,
} from "@robot/shared"
import { Ellipsis, Minus, Plus, User } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { NewAgentDialog } from "../agents/AgentDialogs.tsx"
import { Face } from "../agents/Face.tsx"
import shell from "../shell/shell.module.css"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useOrgChart } from "../state/orgChart.tsx"
import { takeOrgFilter } from "../state/orgFilter.ts"
import { setProfileTarget } from "../state/profileTarget.ts"
import { useUi } from "../state/ui.tsx"
import { AvatarMark } from "../ui/AvatarMark.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { Presence } from "../ui/Presence.tsx"
import { createChartEdit, DROP_AREA_KEY } from "./ChartEdit.tsx"
import { edgeStep } from "./edit.ts"
import { type ChartLayout, layoutChart } from "./layout.ts"
import {
  agentLabel,
  countsLine,
  handoffTip,
  membersWord,
  moreLabel,
  moreWord,
  orgLabel,
  orgTitle,
  outcomeLine,
  stateWord,
} from "./names.ts"
import { OrgListView } from "./OrgListView.tsx"
import styles from "./orgchart.module.css"
import { extent, fitView, type Insets, type View, wheelFactor, ZOOM_STEP, zoomAt } from "./view.ts"

const TEXT_SIZES = { small: 13, default: 14, large: 16 } as const
const MORE_SUFFIX = "/+more"
/** The gap between the controls and the edge of the canvas, and between them and the chart. */
const CONTROLS_GAP = 16
const EMPTY_KEYS: string[] = []

const sameKeys = (a: string[], b: string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i])

/**
 * What decides the positions: the nodes in order, the leads, the tiles, whether each organization
 * node has a goal (which takes one more line), and the lines with the number of digits of their
 * counts. A change of state, of a label, of the words of a goal or of a count with the same digits
 * moves nothing, so it does not lay the chart out again.
 */
const structureKey = (model: ChartModel) =>
  JSON.stringify([
    model.orgs.map((c) => [
      c.key,
      c.leadKey,
      c.more.length > 0,
      c.goal !== null,
      c.nodes.map((n) => n.key),
    ]),
    model.lines.map((l) => [l.id, l.from, l.to, String(l.count ?? "").length]),
  ])

const pathOf = (points: readonly { x: number; y: number }[]) =>
  points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")

const StateDot = (props: { state: AgentState }) => (
  <span class={styles.dot} data-state={props.state} aria-hidden="true" />
)

/** The three kinds of line, each in its own style, so the legend does not rely on colour only. */
const Legend = (props: { capped: boolean; follows: boolean }) => {
  const { t } = useApp()
  return (
    <ul class={styles.legend} aria-label={t("orgchart.legend.label")} data-testid="org-legend">
      <li class={styles.legendItem} data-testid="org-legend-lead">
        <svg class={styles.sample} viewBox="0 0 32 10" aria-hidden="true">
          <line class={styles.line} data-kind="lead" x1="0" y1="5" x2="26" y2="5" />
          <path class={styles.arrowLead} d="M23 1 L31 5 L23 9 z" />
        </svg>
        {t("orgchart.legend.lead")}
      </li>
      <li class={styles.legendItem} data-testid="org-legend-handoff">
        <svg class={styles.sample} viewBox="0 0 32 10" aria-hidden="true">
          <line class={styles.line} data-kind="handoff" x1="0" y1="5" x2="26" y2="5" />
          <path class={styles.arrowHandoff} d="M23 1 L31 5 L23 9 z" />
        </svg>
        {t("orgchart.legend.handoff")}
      </li>
      <li class={styles.legendItem} data-testid="org-legend-structure">
        <svg class={styles.sample} viewBox="0 0 32 10" aria-hidden="true">
          <line class={styles.line} data-kind="structure" x1="0" y1="5" x2="32" y2="5" />
        </svg>
        {t("orgchart.legend.structure")}
      </li>
      <Show when={props.capped}>
        <li class={styles.legendNote} data-testid="org-capped">
          {t("orgchart.legend.capped")}
        </li>
      </Show>
      {/* With the hand-off rule "Along the organizations" the legend ends with this line (spec 029, 030). */}
      <Show when={props.follows}>
        <li class={styles.legendNote} data-testid="org-legend-rule">
          {t("orgchart.legend.rule")}
        </li>
      </Show>
    </ul>
  )
}

/**
 * The org chart (spec 029). It starts nothing. It changes only the members and the lead of a
 * organization, and only when the user edits (see ChartEdit.tsx).
 */
export const OrgChartPage = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const agents = useAgents()
  const chart = useOrgChart()
  const model = chart.model
  // The layout does not change during the drag of a node (spec 029): it waits until the drag ends.
  const [nodeDrag, setNodeDrag] = createSignal(false)

  const unit = createMemo(() => TEXT_SIZES[app.settings.textSize])
  const structure = createMemo<string>((was) => {
    if (nodeDrag() && was !== undefined) return was
    const m = model()
    return m && !m.empty ? structureKey(m) : ""
  })
  // The layout depends on the structure and the text size only: never on motion, on the state of
  // an agent or on the order of events.
  const layout = createMemo<ChartLayout | undefined>(() => {
    const key = structure()
    const m = untrack(model)
    return key && m ? layoutChart(m, unit()) : undefined
  })
  const nodeKeys = createMemo(() => layout()?.nodes.map((n) => n.key) ?? EMPTY_KEYS, EMPTY_KEYS, {
    equals: sameKeys,
  })
  const placed = createMemo(() => new Map((layout()?.nodes ?? []).map((n) => [n.key, n])))
  const lineKeys = createMemo(() => layout()?.lines.map((l) => l.id) ?? EMPTY_KEYS, EMPTY_KEYS, {
    equals: sameKeys,
  })
  const placedLines = createMemo(() => new Map((layout()?.lines ?? []).map((l) => [l.id, l])))
  const modelLines = createMemo(() => new Map((model()?.lines ?? []).map((l) => [l.id, l])))
  const agentNodes = createMemo(() => {
    const m = model()
    const map = new Map<string, ChartAgent>()
    if (!m) return map
    if (m.root) map.set(ROOT_KEY, m.root)
    for (const c of m.orgs) for (const n of c.nodes) map.set(n.key, n)
    return map
  })
  const orgNodes = createMemo(() => new Map((model()?.orgs ?? []).map((c) => [c.key, c])))

  // ---------------------------------------------------------------- Dim, hover and focus
  const [hover, setHover] = createSignal<string>()
  const [focus, setFocus] = createSignal<string>()
  // Escape clears the dim until the pointer or the focus goes to another node.
  const [cleared, setCleared] = createSignal(false)
  createEffect(on([hover, focus], () => setCleared(false), { defer: true }))
  const lit = createMemo(() => {
    const key = cleared() ? undefined : (hover() ?? focus())
    const m = model()
    if (!key || !m) return undefined
    // The tile "+<n> more" belongs to its organization node: it lights what the organization node lights.
    if (key.endsWith(MORE_SUFFIX)) {
      const from = litBy(m, key.slice(0, -MORE_SUFFIX.length))
      return { nodes: new Set([...from.nodes, key]), lines: from.lines }
    }
    return litBy(m, key)
  })
  // The search of the page (spec 029, "Search and the list"). It dims and never removes, so the
  // layout of the whole chart stays: no node, zoom or view moves.
  // The search opens with the text of a hit of the place list, and then belongs to the user
  // (spec 029, "Ways in").
  const [query, setQuery] = createSignal(takeOrgFilter() ?? "")
  const search = createMemo(() => {
    const m = model()
    return m ? orgSearchHits(m, query()) : new Set<string>()
  })
  /** The line stays lit when both of its ends are lit (spec 029). */
  const lineHit = (from: string, to: string) => {
    const hits = search()
    return hits.size === 0 || (hits.has(from) && hits.has(to))
  }
  /** True when the search found nothing: the whole chart dims and one muted line shows. */
  const searchEmpty = createMemo(() => {
    const m = model()
    return m ? orgSearchEmpty(m, query()) : false
  })
  // During a drag nothing dims, so that every ring shows clearly.
  const nodeDim = (key: string) => {
    if (edit.dragging()) return false
    // A search that found nothing dims the whole chart, so the user sees that nothing matched.
    if (searchEmpty()) return true
    const hits = search()
    if (hits.size > 0 && !hits.has(key)) return true
    const l = lit()
    return l !== undefined && !l.nodes.has(key)
  }
  const lineDim = (id: string) => {
    if (edit.dragging()) return false
    if (searchEmpty()) return true
    const line = model()?.lines.find((x) => x.id === id)
    if (line && !lineHit(line.from, line.to)) return true
    const l = lit()
    return l !== undefined && !l.lines.has(id)
  }

  // ---------------------------------------------------------------- The view
  let page: HTMLDivElement | undefined
  let controls: HTMLDivElement | undefined
  const [canvas, setCanvas] = createSignal<HTMLElement>()
  const [size, setSize] = createSignal({ w: 0, h: 0 })
  const [view, setViewSignal] = createSignal<View>({ x: 0, y: 0, zoom: 1 })
  const [animate, setAnimate] = createSignal(false)
  const [dragging, setDragging] = createSignal(false)
  // The page frames the chart by itself until the user changes the view. Opening the page can
  // change the size of the canvas for a moment (the activity panel leaves), so a change of size
  // frames the chart again. After the first zoom, drag or "Fit to view" the view is the user's:
  // only "Fit to view" frames it again.
  let own = false
  const setView = (next: View, withMotion: boolean) => {
    setAnimate(withMotion)
    setViewSignal(next)
  }

  /** The part of the canvas that "Fit to view" leaves free: the strip of the controls. */
  const insets = (): Insets => ({
    top: 0,
    left: 0,
    right: 0,
    bottom: (controls?.offsetHeight ?? 0) + 2 * CONTROLS_GAP,
  })
  const fit = (withMotion: boolean) => {
    const l = layout()
    const s = size()
    if (!l || s.w === 0 || s.h === 0) return
    setView(fitView(extent(l), s, insets()), withMotion)
  }
  const zoomBy = (factor: number) => {
    const s = size()
    own = true
    setView(zoomAt(view(), factor, { x: s.w / 2, y: s.h / 2 }), true)
  }

  createEffect(() => {
    const has = layout() !== undefined
    const s = size()
    if (!has) {
      own = false
      return
    }
    if (own || s.w === 0 || s.h === 0) return
    untrack(() => fit(false))
  })

  // The size of the canvas, also when the canvas comes later (no agent at first).
  createEffect(() => {
    const el = canvas()
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  // The wheel and a pinch on a trackpad zoom around the pointer. A listener that is not passive
  // can keep the page from scrolling.
  createEffect(() => {
    const el = canvas()
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      own = true
      setView(
        zoomAt(untrack(view), wheelFactor(event), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
        false,
      )
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => el.removeEventListener("wheel", onWheel))
  })

  // Dragging the empty canvas moves the view. A node does not move.
  let drag: { id: number; x: number; y: number; view: View } | undefined
  const onPointerDown = (event: PointerEvent) => {
    edit.dropKept()
    const el = canvas()
    if (event.button !== 0 || !el) return
    const target = event.target as Element
    if (target.closest("[data-node], [data-control], [data-popover]")) return
    setMore(undefined)
    el.focus({ preventScroll: true })
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, view: view() }
    el.setPointerCapture(event.pointerId)
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return
    own = true
    setView(
      {
        ...drag.view,
        x: drag.view.x + event.clientX - drag.x,
        y: drag.view.y + event.clientY - drag.y,
      },
      false,
    )
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!drag || drag.id !== event.pointerId) return
    drag = undefined
    setDragging(false)
    canvas()?.releasePointerCapture(event.pointerId)
  }

  // ---------------------------------------------------------------- Go to an agent
  // The place opens on the server whose chart is on the screen: this computer, or the linked
  // server that the chart came from (spec 029, 012).
  const openProfile = (agentId: string) => {
    setMore(undefined)
    setProfileTarget(agentId)
    ui.selectPlace({ kind: "agent", id: agentId }, ui.server()?.id)
  }

  // ---------------------------------------------------------------- Edit on the chart
  const edit = createChartEdit({
    orgNode: (key) => orgNodes().get(key),
    openProfile,
    focusAgent: (agentId, orgId) => setBorn({ agentId, orgId }),
    focusOrg: (orgId) => setBornOrg(orgId),
  })
  // A drag never moves the view by itself: from its start the view is the user's, so that no
  // change of the chart frames it again (spec 029).
  createEffect(() => {
    const on = edit.dragging() !== undefined
    if (on) own = true
    setNodeDrag(on)
  })

  // Edge scroll: while a drag holds the pointer within EDGE_PX of an edge of the canvas, the view
  // moves in that direction. Not on the drop area "No organization" (spec 029).
  createEffect(() => {
    if (!nodeDrag()) return
    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      const ms = Math.min(now - last, 50)
      last = now
      const drag = untrack(edit.dragging)
      const el = untrack(canvas)
      if (drag && el) {
        const { dx, dy } = edgeStep(
          drag,
          el.getBoundingClientRect(),
          ms,
          drag.over === DROP_AREA_KEY,
        )
        if (dx !== 0 || dy !== 0) {
          const v = untrack(view)
          setView({ ...v, x: v.x + dx, y: v.y + dy }, false)
          edit.pointerStays()
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    onCleanup(() => cancelAnimationFrame(frame))
  })

  // After "New agent" or "New agent in this organization" the focus goes to the node of the new
  // agent: its copy in that organization, or the root when it is the main agent. It waits until the
  // form has closed and the chart shows that node. A copy in "No organization" before the agent
  // joins the organization does not count.
  const [born, setBorn] = createSignal<{ agentId: string; orgId: string | null }>()
  createEffect(() => {
    const b = born()
    if (!b || edit.creating()) return
    const nodes = agentNodes()
    const wanted = copyKey(b.orgId ? `o:${b.orgId}` : NO_ORG_KEY, b.agentId)
    const key = nodes.has(wanted)
      ? wanted
      : nodes.get(ROOT_KEY)?.agentId === b.agentId
        ? ROOT_KEY
        : undefined
    if (!key || !nodeKeys().includes(key)) return
    setBorn(undefined)
    edit.dropKept()
    queueMicrotask(() =>
      page
        ?.querySelector<HTMLElement>(`[data-node][data-key="${CSS.escape(key)}"]`)
        ?.focus({ preventScroll: true }),
    )
  })

  // After "New organization" is saved the focus goes to its node (spec 029). It waits until the
  // form has closed and the chart shows the node.
  const [bornOrg, setBornOrg] = createSignal<string>()
  createEffect(() => {
    const id = bornOrg()
    if (!id || edit.creatingOrg()) return
    const key = `o:${id}`
    if (!orgNodes().has(key) || !nodeKeys().includes(key)) return
    setBornOrg(undefined)
    edit.dropKept()
    queueMicrotask(() =>
      page
        ?.querySelector<HTMLElement>(`[data-node][data-key="${CSS.escape(key)}"]`)
        ?.focus({ preventScroll: true }),
    )
  })

  // ---------------------------------------------------------------- The tile "+<n> more"
  const [more, setMore] = createSignal<{ key: string; left: number; top: number }>()
  const moreOrg = () => {
    const open = more()
    return open ? orgNodes().get(open.key) : undefined
  }
  // The list closes when its organization node has no hidden member any more.
  createEffect(() => {
    if (more() && (moreOrg()?.more.length ?? 0) === 0) setMore(undefined)
  })
  let moreOpener: HTMLElement | undefined
  const openMore = (key: string, from: HTMLElement) => {
    const box = page?.getBoundingClientRect()
    const rect = from.getBoundingClientRect()
    if (!box) return
    moreOpener = from
    const width = 280
    setMore({
      key,
      left: Math.max(8, Math.min(rect.left - box.left, box.width - width - 8)),
      top: Math.max(8, Math.min(rect.bottom - box.top + 4, box.height - 200)),
    })
    queueMicrotask(() => page?.querySelector<HTMLElement>("[data-popover] button")?.focus())
  }
  const closeMore = () => {
    setMore(undefined)
    moreOpener?.focus()
  }

  // ---------------------------------------------------------------- The note of a hand-off line
  const [tip, setTip] = createSignal<{ id: string; x: number; y: number }>()
  const showTip = (id: string, event: PointerEvent) => {
    const rect = page?.getBoundingClientRect()
    if (!rect) return
    setTip({ id, x: event.clientX - rect.left + 12, y: event.clientY - rect.top + 16 })
  }
  const tipText = () => {
    const shown = tip()
    const line = shown ? modelLines().get(shown.id) : undefined
    return line ? handoffTip(t, line) : ""
  }

  // ---------------------------------------------------------------- Keys
  // Escape clears the dim, also when the pointer holds it and the focus is elsewhere. It closes
  // the list behind "+<n> more" first.
  onMount(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || edit.menuOpen()) return
      if (more()) closeMore()
      else setCleared(true)
    }
    window.addEventListener("keydown", onEscape)
    onCleanup(() => window.removeEventListener("keydown", onEscape))
  })
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || more() || edit.menuOpen()) return
    if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      zoomBy(ZOOM_STEP)
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault()
      zoomBy(1 / ZOOM_STEP)
    } else if (event.key === "0") {
      event.preventDefault()
      own = true
      fit(true)
    }
  }

  // The focus is never lost when the page changes: a node that goes while it has the focus gives
  // the focus to its organization node, or to the root.
  let focused: { key: string; parent: string | null } | undefined
  const onFocusIn = (event: FocusEvent) => {
    const el = (event.target as Element).closest<HTMLElement>("[data-node]")
    if (!el?.dataset.key) return
    focused = { key: el.dataset.key, parent: placed().get(el.dataset.key)?.parent ?? null }
  }
  const onFocusOut = (event: FocusEvent) => {
    const el = event.target as Element
    // A node that left the page does not report that it lost the focus: keep it for the check below.
    if (el.isConnected && !(event.relatedTarget as Element | null)?.closest("[data-node]"))
      focused = undefined
  }
  createEffect(
    on(
      nodeKeys,
      (keys) => {
        const was = focused
        if (!was || keys.includes(was.key)) return
        const next = (was.parent && keys.includes(was.parent) ? was.parent : undefined) ?? keys[0]
        focused = undefined
        queueMicrotask(() => {
          const target = next
            ? page?.querySelector<HTMLElement>(`[data-node][data-key="${CSS.escape(next)}"]`)
            : undefined
          ;(target ?? canvas())?.focus({ preventScroll: true })
        })
      },
      { defer: true },
    ),
  )

  // A change from a menu gives the focus back to its node when the chart changes. A node that
  // moves to a new place in the page can lose the focus; a node that goes gives it to its channel
  // node, or to the canvas.
  let keptParent: string | null = null
  createEffect(
    on(
      [model, nodeKeys],
      () => {
        const key = edit.kept()
        if (!key) return
        keptParent = placed().get(key)?.parent ?? keptParent
        queueMicrotask(() => {
          const active = document.activeElement
          if (active && active !== document.body && active.isConnected) return
          const find = (k: string | null) =>
            k ? page?.querySelector<HTMLElement>(`[data-node][data-key="${CSS.escape(k)}"]`) : null
          ;(find(key) ?? find(keptParent) ?? canvas())?.focus({ preventScroll: true })
        })
      },
      { defer: true },
    ),
  )

  // ---------------------------------------------------------------- The nodes
  const rectStyle = (key: string): JSX.CSSProperties => {
    const r = placed().get(key)?.rect
    return r
      ? { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` }
      : { display: "none" }
  }
  const pointing = (key: string) => ({
    onPointerEnter: () => setHover(key),
    onPointerLeave: () => setHover((now) => (now === key ? undefined : now)),
    onFocus: () => setFocus(key),
    onBlur: () => setFocus((now) => (now === key ? undefined : now)),
  })

  const AgentNode = (props: { nodeKey: string }) => {
    const node = () => agentNodes().get(props.nodeKey)
    const isRoot = props.nodeKey === ROOT_KEY
    return (
      <Show when={node()}>
        {(n) => {
          const known = () => agents.byId(n().agentId)
          return (
            <button
              type="button"
              class={styles.node}
              style={rectStyle(props.nodeKey)}
              data-node=""
              data-kind={isRoot ? "root" : "agent"}
              data-key={props.nodeKey}
              data-agent-id={n().agentId}
              data-state={n().state}
              data-lead={n().isLead}
              data-dim={nodeDim(props.nodeKey)}
              data-dragged={edit.dragging()?.key === props.nodeKey}
              data-ring={isRoot ? edit.ringOf(ROOT_KEY) : undefined}
              data-over={isRoot ? edit.dragging()?.over === ROOT_KEY : undefined}
              data-testid={isRoot ? "org-root" : "org-node"}
              aria-label={agentLabel(t, n())}
              aria-haspopup="menu"
              onClick={() => {
                if (!edit.takeClick()) openProfile(n().agentId)
              }}
              onPointerDown={(event) => {
                if (!isRoot) edit.pressAgent(event, n())
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                edit.openAgentMenu(n(), isRoot, event.currentTarget, {
                  x: event.clientX,
                  y: event.clientY,
                })
              }}
              onKeyDown={(event) => {
                if (!edit.isMenuKey(event)) return
                event.preventDefault()
                event.stopPropagation()
                edit.openAgentMenu(n(), isRoot, event.currentTarget)
              }}
              {...pointing(props.nodeKey)}
            >
              <span class={styles.identity}>
                <span class={styles.face} aria-hidden="true">
                  <Face
                    face={n().face}
                    image={known()?.faceImage ?? null}
                    size={32}
                    agentId={n().agentId}
                  />
                </span>
                <span class={styles.names}>
                  <span class={styles.nameRow}>
                    <span class={styles.name} title={n().name} data-testid="org-name">
                      {n().name}
                    </span>
                    <Show when={n().isLead}>
                      <span class={styles.leadMark} data-testid="org-lead-mark">
                        {t("orgchart.lead")}
                      </span>
                    </Show>
                  </span>
                  <span class={styles.role} data-testid="org-role">
                    {n().role}
                  </span>
                </span>
              </span>
              <span class={styles.stateRow} data-testid="org-state">
                <StateDot state={n().state} />
                <span class={styles.stateWord}>{stateWord(t, n().state)}</span>
              </span>
              <Show when={n().label}>
                {(label) => (
                  <span class={styles.taskLabel} title={label()} data-testid="org-task-label">
                    {label()}
                  </span>
                )}
              </Show>
            </button>
          )
        }}
      </Show>
    )
  }

  const YouNode = () => (
    <div
      class={styles.node}
      style={rectStyle(ROOT_KEY)}
      tabindex="0"
      role="img"
      data-node=""
      data-kind="root"
      data-key={ROOT_KEY}
      data-dim={nodeDim(ROOT_KEY)}
      data-ring={edit.ringOf(ROOT_KEY)}
      data-over={edit.dragging()?.over === ROOT_KEY}
      data-testid="org-root"
      aria-label={t("orgchart.you")}
      {...pointing(ROOT_KEY)}
    >
      <span class={styles.identity}>
        <span class={styles.face}>
          <AvatarMark icon={User} size={32} />
        </span>
        <span class={styles.names}>
          <span class={styles.name}>{t("orgchart.you")}</span>
        </span>
      </span>
    </div>
  )

  const OrgNode = (props: { nodeKey: string }) => {
    const org = () => orgNodes().get(props.nodeKey)
    return (
      <Show when={org()}>
        {(c) => (
          <button
            type="button"
            class={styles.node}
            style={rectStyle(props.nodeKey)}
            data-node=""
            data-kind="org"
            data-key={props.nodeKey}
            data-org-id={c().orgId ?? ""}
            data-dim={nodeDim(props.nodeKey)}
            data-ring={edit.ringOf(props.nodeKey)}
            data-over={edit.dragging()?.over === props.nodeKey}
            data-dragged={edit.dragging()?.key === props.nodeKey}
            data-parent={c().parentKey ?? ""}
            data-level={c().level}
            data-testid="org-unit"
            aria-label={orgLabel(t, c())}
            aria-haspopup={edit.hasMenu(c()) ? "menu" : undefined}
            onClick={() => {
              // A click on an organization node opens its form. "No organization" does nothing.
              const id = c().orgId
              if (!edit.takeClick() && id) edit.openOrg(id)
            }}
            onPointerDown={(event) => edit.pressOrg(event, c())}
            onContextMenu={(event) => {
              event.preventDefault()
              edit.openOrgMenu(c(), event.currentTarget, { x: event.clientX, y: event.clientY })
            }}
            onKeyDown={(event) => {
              if (!edit.isMenuKey(event)) return
              event.preventDefault()
              event.stopPropagation()
              edit.openOrgMenu(c(), event.currentTarget)
            }}
            {...pointing(props.nodeKey)}
          >
            <span class={styles.orgHead}>
              <span class={styles.orgName} title={orgTitle(t, c())} data-testid="org-unit-name">
                {orgTitle(t, c())}
              </span>
            </span>
            {/* Why the organization exists (spec 030, "Goal"). One line, the whole goal in a note. */}
            <Show when={c().goal}>
              {(line) => (
                <span class={styles.goal} title={c().goalFull ?? ""} data-testid="org-unit-goal">
                  {line()}
                </span>
              )}
            </Show>
            <Show
              when={c().memberCount > 0}
              fallback={
                <span class={styles.counts} data-testid="org-unit-empty">
                  {t("orgchart.noMembers")}
                </span>
              }
            >
              <span class={styles.counts} data-testid="org-unit-counts">
                <span data-testid="org-unit-members">{membersWord(t, c().memberCount)}</span>
                <Show when={countsLine(t, c().counts) !== ""}>
                  <span aria-hidden="true">·</span>
                  <span data-testid="org-unit-states">{countsLine(t, c().counts)}</span>
                </Show>
              </span>
            </Show>
            {/* The work of the drawn members in the last 7 days (spec 029, "Organization node"). */}
            <Show when={outcomeLine(t, c().outcome) !== ""}>
              <span class={styles.outcome} data-testid="org-unit-outcome">
                {outcomeLine(t, c().outcome)}
              </span>
            </Show>
          </button>
        )}
      </Show>
    )
  }

  const MoreTile = (props: { nodeKey: string }) => {
    const org = () => orgNodes().get(props.nodeKey.slice(0, -MORE_SUFFIX.length))
    return (
      <Show when={org()}>
        {(c) => (
          <button
            type="button"
            class={styles.node}
            style={rectStyle(props.nodeKey)}
            data-node=""
            data-kind="more"
            data-key={props.nodeKey}
            data-dim={nodeDim(props.nodeKey)}
            data-testid="org-more"
            aria-label={moreLabel(t, c())}
            aria-haspopup="dialog"
            aria-expanded={more()?.key === c().key}
            onClick={(event) => openMore(c().key, event.currentTarget)}
            {...pointing(props.nodeKey)}
          >
            {moreWord(t, c().more.length)}
          </button>
        )}
      </Show>
    )
  }

  const kindOf = (key: string) => untrack(() => placed().get(key)?.kind)

  /**
   * The "…" button of a node. It stays in the page and shows on the node that has the pointer or
   * the focus, so that the pointer can go from the node onto it. It is no Tab stop: the menu key
   * or Shift+F10 opens the same menu from the keyboard.
   */
  const NodeMenuButton = (props: { nodeKey: string }) => {
    const kind = kindOf(props.nodeKey)
    const agentNode = () => (kind === "more" ? undefined : agentNodes().get(props.nodeKey))
    const orgNode = () => (kind === "org" ? orgNodes().get(props.nodeKey) : undefined)
    const name = () => agentNode()?.name ?? (orgNode() ? orgTitle(t, orgNode() as ChartOrg) : "")
    const has = () =>
      kind === "org" ? edit.hasMenu(orgNode()) : kind !== "more" && agentNode() !== undefined
    const style = (): JSX.CSSProperties => {
      const r = placed().get(props.nodeKey)?.rect
      return r ? { left: `${r.x + r.w - 28}px`, top: `${r.y + 4}px` } : { display: "none" }
    }
    return (
      <Show when={has()}>
        <button
          type="button"
          tabindex="-1"
          class={styles.nodeMenu}
          style={style()}
          data-control=""
          data-shown={
            edit.dragging() === undefined &&
            (hover() === props.nodeKey || focus() === props.nodeKey)
          }
          data-key={props.nodeKey}
          data-testid="org-node-menu"
          aria-label={t("orgchart.edit.more", { name: name() })}
          aria-haspopup="menu"
          onPointerEnter={() => setHover(props.nodeKey)}
          onPointerLeave={() => setHover((now) => (now === props.nodeKey ? undefined : now))}
          onClick={(event) => {
            const opener =
              page?.querySelector<HTMLElement>(
                `[data-node][data-key="${CSS.escape(props.nodeKey)}"]`,
              ) ?? undefined
            const at = event.currentTarget.getBoundingClientRect()
            const point = { x: at.left, y: at.bottom + 4 }
            const a = agentNode()
            const c = orgNode()
            if (c && opener) edit.openOrgMenu(c, opener, point)
            else if (a && opener) edit.openAgentMenu(a, props.nodeKey === ROOT_KEY, opener, point)
          }}
        >
          <Ellipsis size={14} />
        </button>
      </Show>
    )
  }

  // ---------------------------------------------------------------- The page
  const [creating, setCreating] = createSignal(false)

  return (
    <div class={styles.page} ref={page} data-testid="org-page">
      {/* A linked server that is not online: its name and no chart. The chart is not kept. */}
      <Show when={chart.source() === "offline"}>
        <p class={shell.pageNotice} data-testid="org-offline">
          {t("link.state.offline", { name: ui.server()?.name ?? "" })}
        </p>
      </Show>
      {/* A server of an older build has no org chart request (spec 012, "Messages"). */}
      <Show when={chart.unsupported()}>
        <p class={shell.pageNotice} data-testid="org-open-on-server">
          {t("link.openOnServer", { name: ui.server()?.name ?? "" })}
        </p>
      </Show>
      <Show when={model()}>
        {(m) => (
          <>
            {/* The header line: the search, the legend of the lines, the choice of the view and
                the button "New organization". */}
            <div class={styles.head} data-testid="org-head">
              <Show when={!m().empty}>
                <input
                  class={styles.search}
                  type="search"
                  value={query()}
                  placeholder={t("orgchart.search")}
                  aria-label={t("orgchart.search")}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    // Escape clears the search, as it does in the place list (spec 001).
                    if (e.key !== "Escape") return
                    e.preventDefault()
                    setQuery("")
                  }}
                  data-testid="org-search"
                />
                <Legend capped={m().handoffsCapped} follows={m().handOffRule === "organizations"} />
                <fieldset
                  class={styles.viewChoice}
                  aria-label={t("orgchart.view")}
                  data-testid="org-view-choice"
                >
                  <button
                    type="button"
                    class={styles.viewButton}
                    aria-pressed={ui.ui.orgView !== "list"}
                    onClick={() => ui.setOrgView("chart")}
                    data-testid="org-view-chart"
                  >
                    {t("orgchart.view.chart")}
                  </button>
                  <button
                    type="button"
                    class={styles.viewButton}
                    aria-pressed={ui.ui.orgView === "list"}
                    onClick={() => ui.setOrgView("list")}
                    data-testid="org-view-list"
                  >
                    {t("orgchart.view.list")}
                  </button>
                </fieldset>
              </Show>
              <Show when={edit.canEdit()}>
                <span class={styles.headButton}>
                  <Button onClick={edit.newOrg} data-testid="org-new">
                    {t("orgs.new")}
                  </Button>
                </span>
              </Show>
            </div>
            {/* Nothing found: the whole chart dims, and one muted line says so (spec 029). */}
            <Show when={searchEmpty()}>
              <p class={styles.searchNote} role="status" data-testid="org-search-empty">
                {t("orgchart.search.empty")}
              </p>
            </Show>
            <Show
              when={!m().empty}
              fallback={
                <div class={styles.empty} data-testid="org-empty">
                  <p>{t("orgchart.empty")}</p>
                  <Show when={ui.canChange()}>
                    <Button
                      variant="primary"
                      onClick={() => setCreating(true)}
                      data-testid="org-new-agent"
                    >
                      {t("agents.new")}
                    </Button>
                  </Show>
                </div>
              }
            >
              {/* The list of the same chart (spec 029, "Search and the list"). It is the builder
                  of the phone, so the two views never disagree. */}
              <Show
                when={ui.ui.orgView === "list"}
                fallback={
                  <section
                    ref={setCanvas}
                    class={styles.viewport}
                    tabindex="-1"
                    aria-label={t("page.orgchart")}
                    aria-description={
                      edit.canEdit()
                        ? `${t("orgchart.canvas.hint")} ${t("orgchart.edit.hint")}`
                        : t("orgchart.canvas.hint")
                    }
                    data-dragging={dragging()}
                    data-drag-node={edit.dragging() !== undefined}
                    data-testid="org-canvas"
                    onKeyDown={onKeyDown}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onFocusIn={onFocusIn}
                    onFocusOut={onFocusOut}
                  >
                    <div
                      class={styles.surface}
                      data-animate={animate()}
                      data-testid="org-surface"
                      data-zoom={view().zoom.toFixed(3)}
                      data-x={view().x.toFixed(1)}
                      data-y={view().y.toFixed(1)}
                      style={{
                        transform: `translate(${view().x}px, ${view().y}px) scale(${view().zoom})`,
                      }}
                    >
                      <svg
                        class={styles.lines}
                        width={(layout()?.bounds.x ?? 0) + (layout()?.bounds.w ?? 0)}
                        height={(layout()?.bounds.y ?? 0) + (layout()?.bounds.h ?? 0)}
                        aria-hidden="true"
                      >
                        <For each={layout()?.areas ?? []}>
                          {(area) => (
                            <rect
                              class={styles.area}
                              data-depth={area.depth % 5}
                              data-testid="org-area"
                              x={area.rect.x}
                              y={area.rect.y}
                              width={area.rect.w}
                              height={area.rect.h}
                              rx="12"
                            />
                          )}
                        </For>
                        <defs>
                          <marker
                            id="org-arrow-lead"
                            markerUnits="userSpaceOnUse"
                            markerWidth="10"
                            markerHeight="10"
                            refX="10"
                            refY="5"
                            orient="auto"
                          >
                            <path class={styles.arrowLead} d="M0 0 L10 5 L0 10 z" />
                          </marker>
                          <marker
                            id="org-arrow-handoff"
                            markerUnits="userSpaceOnUse"
                            markerWidth="10"
                            markerHeight="10"
                            refX="10"
                            refY="5"
                            orient="auto"
                          >
                            <path class={styles.arrowHandoff} d="M0 0 L10 5 L0 10 z" />
                          </marker>
                        </defs>
                        <For each={lineKeys()}>
                          {(id) => {
                            const line = () => placedLines().get(id)
                            return (
                              <Show when={line()}>
                                {(l) => (
                                  <g data-testid="org-line" data-id={id} data-kind={l().kind}>
                                    <path
                                      class={styles.line}
                                      data-kind={l().kind}
                                      data-dim={lineDim(id)}
                                      d={pathOf(l().points)}
                                      marker-end={
                                        l().kind === "lead"
                                          ? "url(#org-arrow-lead)"
                                          : l().kind === "handoff"
                                            ? "url(#org-arrow-handoff)"
                                            : undefined
                                      }
                                    />
                                    <Show when={l().kind === "handoff"}>
                                      <path
                                        class={styles.hit}
                                        d={pathOf(l().points)}
                                        data-testid="org-line-hit"
                                        onPointerEnter={(event) => showTip(id, event)}
                                        onPointerMove={(event) => showTip(id, event)}
                                        onPointerLeave={() => setTip(undefined)}
                                      />
                                    </Show>
                                  </g>
                                )}
                              </Show>
                            )
                          }}
                        </For>
                      </svg>
                      <For each={nodeKeys()}>
                        {(key) => (
                          <Switch>
                            <Match when={kindOf(key) === "root"}>
                              <Show when={m().root} fallback={<YouNode />}>
                                <AgentNode nodeKey={key} />
                              </Show>
                            </Match>
                            <Match when={kindOf(key) === "org"}>
                              <OrgNode nodeKey={key} />
                            </Match>
                            <Match when={kindOf(key) === "more"}>
                              <MoreTile nodeKey={key} />
                            </Match>
                            <Match when={true}>
                              <AgentNode nodeKey={key} />
                            </Match>
                          </Switch>
                        )}
                      </For>
                      <For each={lineKeys()}>
                        {(id) => (
                          <Show when={placedLines().get(id)?.label}>
                            {(rect) => (
                              <span
                                class={styles.count}
                                style={{
                                  left: `${rect().x}px`,
                                  top: `${rect().y}px`,
                                  width: `${rect().w}px`,
                                  height: `${rect().h}px`,
                                }}
                                data-dim={lineDim(id)}
                                data-id={id}
                                data-testid="org-line-count"
                                aria-hidden="true"
                                onPointerEnter={(event) => showTip(id, event)}
                                onPointerMove={(event) => showTip(id, event)}
                                onPointerLeave={() => setTip(undefined)}
                              >
                                {modelLines().get(id)?.count ?? ""}
                              </span>
                            )}
                          </Show>
                        )}
                      </For>
                      <For each={nodeKeys()}>{(key) => <NodeMenuButton nodeKey={key} />}</For>
                    </div>
                    <edit.NoticeLine />
                    <edit.DropArea />
                    <div
                      ref={controls}
                      class={styles.controls}
                      data-control=""
                      data-testid="org-controls"
                    >
                      <IconButton
                        label={t("orgchart.zoomOut")}
                        onClick={() => zoomBy(1 / ZOOM_STEP)}
                        data-testid="org-zoom-out"
                      >
                        <Minus size={16} />
                      </IconButton>
                      <IconButton
                        label={t("orgchart.zoomIn")}
                        onClick={() => zoomBy(ZOOM_STEP)}
                        data-testid="org-zoom-in"
                      >
                        <Plus size={16} />
                      </IconButton>
                      <button
                        type="button"
                        class={styles.fit}
                        onClick={() => {
                          own = true
                          fit(true)
                        }}
                        data-testid="org-fit"
                      >
                        {t("orgchart.fit")}
                      </button>
                    </div>
                  </section>
                }
              >
                <OrgListView
                  list={buildOrgList(m())}
                  dim={search()}
                  onAgent={(agentId) => openProfile(agentId)}
                  onOrg={(orgId) => edit.openOrg(orgId)}
                />
              </Show>
            </Show>
          </>
        )}
      </Show>
      <Show when={tip()}>
        {(shown) => (
          <div
            class={styles.tip}
            role="tooltip"
            style={{ left: `${shown().x}px`, top: `${shown().y}px` }}
            data-testid="org-line-tip"
          >
            {tipText()}
          </div>
        )}
      </Show>
      <Show when={more()}>
        {(open) => (
          <Show when={moreOrg()}>
            {(c) => (
              <div
                class={styles.popover}
                role="dialog"
                aria-label={t("orgchart.more.title", { organization: orgTitle(t, c()) })}
                style={{ left: `${open().left}px`, top: `${open().top}px` }}
                data-popover=""
                data-testid="org-more-list"
              >
                <div class={styles.popoverTitle}>
                  {t("orgchart.more.title", { organization: orgTitle(t, c()) })}
                </div>
                <ul class={styles.popoverList}>
                  <For each={c().more}>
                    {(member) => (
                      <li>
                        <button
                          type="button"
                          class={styles.row}
                          onClick={() => openProfile(member.agentId)}
                          data-testid="org-more-row"
                          data-agent-id={member.agentId}
                        >
                          <Face
                            face={member.face}
                            image={agents.byId(member.agentId)?.faceImage ?? null}
                            size={24}
                          />
                          <span class={styles.rowName}>{member.name}</span>
                          <span class={styles.rowState}>
                            <StateDot state={member.state} />
                            {stateWord(t, member.state)}
                          </span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            )}
          </Show>
        )}
      </Show>
      <Presence when={creating()}>
        {() => <NewAgentDialog onClose={() => setCreating(false)} />}
      </Presence>
      <edit.Overlays />
    </div>
  )
}
