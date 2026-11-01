import {
  type Edge,
  type MessageKey,
  type Schedule,
  STEP_KINDS,
  type Step,
  type StepKind,
  type Trigger,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunDetail,
} from "@robot/shared"
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { ScheduleFields } from "../routines/ScheduleFields.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./workflows.module.css"

const NODE_W = 180
const NODE_H = 64
const ZOOM_MIN = 0.3
const ZOOM_MAX = 2

/** A plain copy of store data: a store proxy cannot cross the IPC boundary. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

const newId = () => crypto.randomUUID().slice(0, 8)

const blank = (
  kind: StepKind,
  x: number,
  y: number,
  name: string,
  agentId: string,
  channelId: string,
): Step => {
  const base = { id: newId(), name, x, y }
  switch (kind) {
    case "agent":
      return { ...base, kind, agentId, prompt: "", continueOnFailure: false }
    case "condition":
      return { ...base, kind, contains: "" }
    case "approval":
      return { ...base, kind, message: "" }
    case "post":
      return { ...base, kind, channelId, text: "{{input}}" }
  }
}

export const WorkflowEditor = (props: { workflow: Workflow | null; onBack: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const channels = useChannels()
  const [saved, setSaved] = createSignal<Workflow | null>(props.workflow)
  const [name, setName] = createSignal(props.workflow?.name ?? "")
  const [trigger, setTrigger] = createSignal<Trigger>(props.workflow?.trigger ?? { kind: "manual" })
  const [scheduleOk, setScheduleOk] = createSignal(true)
  const [graph, setGraph] = createStore<{ steps: Step[]; edges: Edge[] }>({
    steps: props.workflow ? structuredClone([...props.workflow.steps]) : [],
    edges: props.workflow ? structuredClone([...props.workflow.edges]) : [],
  })
  const [selected, setSelected] = createSignal<{ kind: "step" | "edge"; id: string }>()
  const [view, setView] = createSignal({ x: 40, y: 40, zoom: 1 })
  const [link, setLink] = createSignal<{
    from: string
    branch?: "yes" | "no"
    x: number
    y: number
  }>()
  const [error, setError] = createSignal<ErrorText>()
  const [watched, setWatched] = createSignal<string>()
  let canvas: HTMLDivElement | undefined

  const [runs, { refetch: refetchRuns }] = createResource(
    () => saved()?.id,
    (workflowId) => call("workflows.runs", { workflowId }),
    { initialValue: [] as readonly WorkflowRun[] },
  )
  const [detail, { refetch: refetchDetail }] = createResource(watched, (runId) =>
    call("workflows.runDetail", { runId }),
  )
  const live = () => detail.latest as WorkflowRunDetail | undefined
  const running = () => live()?.run.state === "running" || runs().some((r) => r.state === "running")
  onCleanup(
    window.robot.on("workflows.run", ({ runId }) => {
      if (runId === watched()) void refetchDetail()
      void refetchRuns()
    }),
  )
  createEffect(() => {
    // Watch the newest run, so the steps light up from the first moment.
    const newest = runs()[0]
    if (newest && watched() === undefined) setWatched(newest.id)
  })
  const stateOf = (stepId: string) => live()?.steps.find((s) => s.stepId === stepId)?.state

  const readOnly = () => running()
  const step = (id: string) => graph.steps.find((s) => s.id === id)
  const selectedStep = () => {
    const s = selected()
    return s?.kind === "step" ? step(s.id) : undefined
  }

  const world = (event: { clientX: number; clientY: number }) => {
    const rect = canvas?.getBoundingClientRect()
    const v = view()
    return {
      x: (event.clientX - (rect?.left ?? 0) - v.x) / v.zoom,
      y: (event.clientY - (rect?.top ?? 0) - v.y) / v.zoom,
    }
  }

  onMount(() => {
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const v = view()
      if (event.ctrlKey || event.metaKey) {
        // A pinch on a trackpad, or Ctrl with the wheel: zoom around the pointer.
        const rect = canvas?.getBoundingClientRect()
        const px = event.clientX - (rect?.left ?? 0)
        const py = event.clientY - (rect?.top ?? 0)
        const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * Math.exp(-event.deltaY * 0.01)))
        const k = zoom / v.zoom
        setView({ zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k })
      } else setView({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY })
    }
    canvas?.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => canvas?.removeEventListener("wheel", onWheel))
  })

  const track = (
    onMove: (event: PointerEvent) => void,
    onUp: (event: PointerEvent) => void = () => {},
  ) => {
    const move = (e: PointerEvent) => onMove(e)
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      onUp(e)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const startPan = (event: PointerEvent) => {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).dataset.bg) return
    setSelected(undefined)
    const start = { x: event.clientX, y: event.clientY, v: view() }
    track((e) =>
      setView({
        ...start.v,
        x: start.v.x + e.clientX - start.x,
        y: start.v.y + e.clientY - start.y,
      }),
    )
  }

  const startDrag = (id: string, event: PointerEvent) => {
    if ((event.target as HTMLElement).dataset.handle) return
    setSelected({ kind: "step", id })
    if (readOnly()) return
    const origin = step(id)
    if (!origin) return
    const start = { x: event.clientX, y: event.clientY, nx: origin.x, ny: origin.y }
    const zoom = view().zoom
    track((e) =>
      setGraph(
        "steps",
        (s) => s.id === id,
        produce((s: Step) => {
          const pos = s as { x: number; y: number }
          pos.x = Math.round(start.nx + (e.clientX - start.x) / zoom)
          pos.y = Math.round(start.ny + (e.clientY - start.y) / zoom)
        }),
      ),
    )
  }

  const startLink = (from: string, branch: "yes" | "no" | undefined, event: PointerEvent) => {
    event.stopPropagation()
    if (readOnly()) return
    const p = world(event)
    setLink({ from, ...(branch ? { branch } : {}), ...p })
    track(
      (e) => setLink((l) => (l ? { ...l, ...world(e) } : l)),
      (e) => {
        const target = (
          document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
        )?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId
        setLink(undefined)
        if (!target || target === from) return
        if (graph.edges.some((x) => x.from === from && x.to === target && x.branch === branch))
          return
        setGraph("edges", (edges) => [
          ...edges,
          { id: newId(), from, to: target, ...(branch ? { branch } : {}) },
        ])
      },
    )
  }

  const addStep = (kind: StepKind) => {
    if (readOnly()) return
    const count = graph.steps.length
    const v = view()
    const s = blank(
      kind,
      Math.round((40 - v.x) / v.zoom + (count % 3) * 230),
      Math.round((40 - v.y) / v.zoom + Math.floor(count / 3) * 110),
      t(`workflows.step.${kind}` as MessageKey),
      agents.agents()[0]?.id ?? "",
      channels.channels()[0]?.id ?? "",
    )
    setGraph("steps", (steps) => [...steps, s])
    setSelected({ kind: "step", id: s.id })
  }

  const remove = () => {
    const s = selected()
    if (!s || readOnly()) return
    if (s.kind === "step") {
      setGraph("steps", (steps) => steps.filter((x) => x.id !== s.id))
      setGraph("edges", (edges) => edges.filter((e) => e.from !== s.id && e.to !== s.id))
    } else setGraph("edges", (edges) => edges.filter((e) => e.id !== s.id))
    setSelected(undefined)
  }

  const patchStep = (id: string, patch: Partial<Step>) =>
    setGraph(
      "steps",
      (s) => s.id === id,
      produce((s: Step) => Object.assign(s, patch)),
    )

  const save = async (): Promise<Workflow | undefined> => {
    const serverId = ui.server()?.id
    if (!serverId) return
    setError(undefined)
    try {
      const body = {
        name: name().trim() || t("workflows.untitled"),
        trigger: trigger(),
        steps: plain(graph.steps),
        edges: plain(graph.edges),
      }
      const current = saved()
      const next = current
        ? await call("workflows.update", { id: current.id, patch: body })
        : await call("workflows.create", { serverId, ...body })
      setSaved(next)
      return next
    } catch (e) {
      setError(describeError(e))
    }
  }

  const run = async () => {
    const next = await save()
    if (!next) return
    try {
      const started = await call("workflows.run", { id: next.id })
      setWatched(started.id)
      void refetchRuns()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const point = (s: Step, side: "in" | "out", branch?: "yes" | "no") => ({
    x: s.x + (side === "out" ? NODE_W : 0),
    y:
      s.y +
      (side === "in"
        ? NODE_H / 2
        : branch === "yes"
          ? 18
          : branch === "no"
            ? NODE_H - 18
            : NODE_H / 2),
  })
  const path = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    `M ${a.x} ${a.y} C ${a.x + 60} ${a.y}, ${b.x - 60} ${b.y}, ${b.x} ${b.y}`

  const triggerKind = () => trigger().kind

  return (
    <div class={styles.editor} data-testid="wf-editor">
      <div class={styles.toolbar}>
        <Button onClick={props.onBack} data-testid="wf-back">
          {t("workflows.back")}
        </Button>
        <input
          class={styles.name}
          value={name()}
          disabled={readOnly()}
          placeholder={t("workflows.untitled")}
          aria-label={t("workflows.name")}
          onInput={(e) => setName(e.currentTarget.value)}
          data-testid="wf-name"
        />
        <For each={STEP_KINDS}>
          {(k) => (
            <Button disabled={readOnly()} onClick={() => addStep(k)} data-testid={`wf-add-${k}`}>
              + {t(`workflows.step.${k}` as MessageKey)}
            </Button>
          )}
        </For>
        <span class={styles.spacer} />
        <Button
          onClick={() => setView({ ...view(), zoom: Math.max(ZOOM_MIN, view().zoom / 1.2) })}
          data-testid="wf-zoom-out"
        >
          −
        </Button>
        <span class={styles.hint} data-testid="wf-zoom">
          {Math.round(view().zoom * 100)}%
        </span>
        <Button
          onClick={() => setView({ ...view(), zoom: Math.min(ZOOM_MAX, view().zoom * 1.2) })}
          data-testid="wf-zoom-in"
        >
          +
        </Button>
        <Button disabled={readOnly() || !scheduleOk()} onClick={save} data-testid="wf-save">
          {t("agents.save")}
        </Button>
        <Show
          when={running()}
          fallback={
            <Button variant="primary" onClick={run} data-testid="wf-run">
              {t("workflows.run")}
            </Button>
          }
        >
          <Button
            onClick={() => {
              const id = runs().find((r) => r.state === "running")?.id
              if (id) void call("workflows.stop", { runId: id })
            }}
            data-testid="wf-stop"
          >
            {t("workflows.stop")}
          </Button>
        </Show>
      </div>

      <Show when={readOnly()}>
        <p class={styles.banner} data-testid="wf-readonly">
          {t("workflows.readOnly")}
        </p>
      </Show>
      <Show when={error()}>
        {(err) => (
          <p class={styles.error} role="alert" data-testid="wf-error">
            {t(err().key, err().params)}
          </p>
        )}
      </Show>

      <div class={styles.triggerRow}>
        <label class={styles.inline}>
          {t("workflows.trigger")}
          <select
            class={styles.input}
            disabled={readOnly()}
            value={triggerKind()}
            onChange={(e) => {
              const kind = e.currentTarget.value as Trigger["kind"]
              setTrigger(
                kind === "manual"
                  ? { kind }
                  : kind === "schedule"
                    ? { kind, schedule: { kind: "daily", times: ["09:00"] } }
                    : { kind, channelId: channels.channels()[0]?.id ?? "", contains: "" },
              )
            }}
            data-testid="wf-trigger-kind"
          >
            <For each={["manual", "schedule", "channel"] as const}>
              {(k) => <option value={k}>{t(`workflows.trigger.${k}` as MessageKey)}</option>}
            </For>
          </select>
        </label>
        <Show
          when={
            trigger().kind === "channel"
              ? (trigger() as Extract<Trigger, { kind: "channel" }>)
              : undefined
          }
        >
          {(tr) => (
            <>
              <select
                class={styles.input}
                disabled={readOnly()}
                value={tr().channelId}
                onChange={(e) => setTrigger({ ...tr(), channelId: e.currentTarget.value })}
                aria-label={t("workflows.trigger.channel")}
                data-testid="wf-trigger-channel"
              >
                <For each={channels.channels()}>
                  {(c) => <option value={c.id}>{c.name}</option>}
                </For>
              </select>
              <input
                class={styles.input}
                disabled={readOnly()}
                value={tr().contains}
                placeholder={t("workflows.trigger.contains")}
                aria-label={t("workflows.trigger.contains")}
                onInput={(e) => setTrigger({ ...tr(), contains: e.currentTarget.value })}
                data-testid="wf-trigger-contains"
              />
            </>
          )}
        </Show>
        <Show when={trigger().kind === "schedule"}>
          <div class={styles.scheduleBox} data-testid="wf-trigger-schedule">
            <ScheduleFields
              {...(trigger().kind === "schedule"
                ? { initial: (trigger() as { schedule: Schedule }).schedule }
                : {})}
              onChange={(schedule, ok) => {
                setScheduleOk(ok)
                if (trigger().kind === "schedule") setTrigger({ kind: "schedule", schedule })
              }}
            />
          </div>
        </Show>
      </div>

      <div class={styles.workspace}>
        <div
          class={styles.canvas}
          ref={canvas}
          onPointerDown={startPan}
          data-testid="wf-canvas"
          data-zoom={view().zoom.toFixed(2)}
          data-bg="1"
        >
          <div
            class={styles.surface}
            data-bg="1"
            style={{ transform: `translate(${view().x}px, ${view().y}px) scale(${view().zoom})` }}
          >
            <svg class={styles.edges} aria-hidden="true">
              <For each={graph.edges}>
                {(e) => {
                  const a = () => step(e.from)
                  const b = () => step(e.to)
                  return (
                    <Show when={a() && b()}>
                      <path
                        d={path(point(a() as Step, "out", e.branch), point(b() as Step, "in"))}
                        class={styles.edge}
                        data-selected={selected()?.id === e.id}
                        data-testid="wf-edge"
                        onPointerDown={(ev) => {
                          ev.stopPropagation()
                          setSelected({ kind: "edge", id: e.id })
                        }}
                      />
                    </Show>
                  )
                }}
              </For>
              <Show when={link()}>
                {(l) => (
                  <path
                    d={path(point(step(l().from) as Step, "out", l().branch), {
                      x: l().x,
                      y: l().y,
                    })}
                    class={styles.edge}
                    data-draft="true"
                  />
                )}
              </Show>
            </svg>
            <For each={graph.steps}>
              {(s) => (
                <div
                  class={styles.node}
                  style={{
                    left: `${s.x}px`,
                    top: `${s.y}px`,
                    width: `${NODE_W}px`,
                    height: `${NODE_H}px`,
                  }}
                  data-node-id={s.id}
                  data-kind={s.kind}
                  data-state={stateOf(s.id) ?? "idle"}
                  data-selected={selected()?.id === s.id}
                  data-testid="wf-node"
                  onPointerDown={(e) => startDrag(s.id, e)}
                >
                  <span class={styles.nodeKind}>{t(`workflows.step.${s.kind}` as MessageKey)}</span>
                  <span class={styles.nodeName}>{s.name}</span>
                  <span class={styles.handleIn} data-handle="in" />
                  <Show
                    when={s.kind === "condition"}
                    fallback={
                      <span
                        class={styles.handleOut}
                        data-handle="out"
                        data-testid="wf-handle-out"
                        onPointerDown={(e) => startLink(s.id, undefined, e)}
                      />
                    }
                  >
                    <span
                      class={`${styles.handleOut} ${styles.yes}`}
                      data-handle="out"
                      data-testid="wf-handle-yes"
                      title={t("workflows.branch.yes")}
                      onPointerDown={(e) => startLink(s.id, "yes", e)}
                    />
                    <span
                      class={`${styles.handleOut} ${styles.no}`}
                      data-handle="out"
                      data-testid="wf-handle-no"
                      title={t("workflows.branch.no")}
                      onPointerDown={(e) => startLink(s.id, "no", e)}
                    />
                  </Show>
                </div>
              )}
            </For>
          </div>
          <Show when={graph.steps.length === 0}>
            <p class={styles.empty} data-testid="wf-empty">
              {t("workflows.canvas.empty")}
            </p>
          </Show>
        </div>

        <aside class={styles.panel} data-testid="wf-panel">
          <Show
            when={selectedStep()}
            fallback={
              <Show
                when={selected()?.kind === "edge"}
                fallback={<p class={styles.hint}>{t("workflows.panel.empty")}</p>}
              >
                <Button disabled={readOnly()} onClick={remove} data-testid="wf-delete">
                  {t("workflows.deleteEdge")}
                </Button>
              </Show>
            }
          >
            {(s) => (
              <div class={styles.fields}>
                <label class={styles.field}>
                  <span>{t("workflows.step.name")}</span>
                  <input
                    class={styles.input}
                    disabled={readOnly()}
                    value={s().name}
                    onInput={(e) => patchStep(s().id, { name: e.currentTarget.value })}
                    data-testid="wf-step-name"
                  />
                </label>
                <Show
                  when={
                    s().kind === "agent" ? (s() as Extract<Step, { kind: "agent" }>) : undefined
                  }
                >
                  {(a) => (
                    <>
                      <label class={styles.field}>
                        <span>{t("routines.field.agent")}</span>
                        <select
                          class={styles.input}
                          disabled={readOnly()}
                          value={a().agentId}
                          onChange={(e) => patchStep(a().id, { agentId: e.currentTarget.value })}
                          data-testid="wf-step-agent"
                        >
                          <For each={agents.agents()}>
                            {(x) => <option value={x.id}>{x.name}</option>}
                          </For>
                        </select>
                      </label>
                      <label class={styles.field}>
                        <span>{t("workflows.step.prompt")}</span>
                        <textarea
                          class={styles.input}
                          rows={5}
                          disabled={readOnly()}
                          value={a().prompt}
                          onInput={(e) => patchStep(a().id, { prompt: e.currentTarget.value })}
                          data-testid="wf-step-prompt"
                        />
                        <span class={styles.hint}>{t("workflows.step.prompt.hint")}</span>
                      </label>
                      <label class={styles.inline}>
                        <input
                          type="checkbox"
                          disabled={readOnly()}
                          checked={a().continueOnFailure}
                          onChange={(e) =>
                            patchStep(a().id, { continueOnFailure: e.currentTarget.checked })
                          }
                          data-testid="wf-step-continue"
                        />
                        {t("workflows.step.continue")}
                      </label>
                    </>
                  )}
                </Show>
                <Show
                  when={
                    s().kind === "condition"
                      ? (s() as Extract<Step, { kind: "condition" }>)
                      : undefined
                  }
                >
                  {(c) => (
                    <label class={styles.field}>
                      <span>{t("workflows.step.contains")}</span>
                      <input
                        class={styles.input}
                        disabled={readOnly()}
                        value={c().contains}
                        onInput={(e) => patchStep(c().id, { contains: e.currentTarget.value })}
                        data-testid="wf-step-contains"
                      />
                      <span class={styles.hint}>{t("workflows.step.contains.hint")}</span>
                    </label>
                  )}
                </Show>
                <Show
                  when={
                    s().kind === "approval"
                      ? (s() as Extract<Step, { kind: "approval" }>)
                      : undefined
                  }
                >
                  {(a) => (
                    <label class={styles.field}>
                      <span>{t("workflows.step.message")}</span>
                      <input
                        class={styles.input}
                        disabled={readOnly()}
                        value={a().message}
                        onInput={(e) => patchStep(a().id, { message: e.currentTarget.value })}
                        data-testid="wf-step-message"
                      />
                    </label>
                  )}
                </Show>
                <Show
                  when={s().kind === "post" ? (s() as Extract<Step, { kind: "post" }>) : undefined}
                >
                  {(p) => (
                    <>
                      <label class={styles.field}>
                        <span>{t("workflows.step.channel")}</span>
                        <select
                          class={styles.input}
                          disabled={readOnly()}
                          value={p().channelId}
                          onChange={(e) => patchStep(p().id, { channelId: e.currentTarget.value })}
                          data-testid="wf-step-channel"
                        >
                          <For each={channels.channels()}>
                            {(c) => <option value={c.id}>{c.name}</option>}
                          </For>
                        </select>
                      </label>
                      <label class={styles.field}>
                        <span>{t("workflows.step.text")}</span>
                        <textarea
                          class={styles.input}
                          rows={4}
                          disabled={readOnly()}
                          value={p().text}
                          onInput={(e) => patchStep(p().id, { text: e.currentTarget.value })}
                          data-testid="wf-step-text"
                        />
                      </label>
                    </>
                  )}
                </Show>
                <Show when={live()?.steps.find((x) => x.stepId === s().id)}>
                  {(r) => (
                    <Show when={r().state === "waiting"}>
                      <div class={styles.actions}>
                        <Button
                          variant="primary"
                          onClick={() =>
                            call("workflows.approve", {
                              runId: live()?.run.id ?? "",
                              stepId: s().id,
                              approved: true,
                            })
                          }
                          data-testid="wf-approve"
                        >
                          {t("workflows.approve")}
                        </Button>
                        <Button
                          onClick={() =>
                            call("workflows.approve", {
                              runId: live()?.run.id ?? "",
                              stepId: s().id,
                              approved: false,
                            })
                          }
                          data-testid="wf-reject"
                        >
                          {t("workflows.reject")}
                        </Button>
                      </div>
                    </Show>
                  )}
                </Show>
                <Button disabled={readOnly()} onClick={remove} data-testid="wf-delete">
                  {t("workflows.deleteStep")}
                </Button>
              </div>
            )}
          </Show>
        </aside>
      </div>

      <section class={styles.history} data-testid="wf-history">
        <h3 class={styles.historyTitle}>{t("workflows.history")}</h3>
        <Show when={runs().length === 0}>
          <p class={styles.hint}>{t("workflows.history.empty")}</p>
        </Show>
        <div class={styles.runList}>
          <For each={runs()}>
            {(r) => (
              <button
                type="button"
                class={styles.runRow}
                aria-pressed={watched() === r.id}
                data-state={r.state}
                data-testid="wf-run-row"
                onClick={() => setWatched(r.id)}
              >
                <span>{new Date(r.startedAt).toLocaleString()}</span>
                <span>{t(`workflows.trigger.${r.trigger}` as MessageKey)}</span>
                <span class={styles.runState}>
                  {t(`workflows.runState.${r.state}` as MessageKey)}
                </span>
              </button>
            )}
          </For>
        </div>
        <Show when={live()}>
          {(d) => (
            <div class={styles.runDetail} data-testid="wf-run-detail">
              <For each={d().steps}>
                {(s) => (
                  <details class={styles.stepRun} data-state={s.state} data-testid="wf-run-step">
                    <summary>
                      <span>{s.name}</span>
                      <span class={styles.runState}>
                        {t(`workflows.stepState.${s.state}` as MessageKey)}
                      </span>
                    </summary>
                    <Show when={s.input}>
                      <div class={styles.hint}>{t("chat.tool.input")}</div>
                      <pre>{s.input}</pre>
                    </Show>
                    <Show when={s.result}>
                      <div class={styles.hint}>{t("chat.tool.output")}</div>
                      <pre data-testid="wf-step-result">{s.result}</pre>
                    </Show>
                    <Show when={s.error}>
                      <pre class={styles.error}>{s.error}</pre>
                    </Show>
                  </details>
                )}
              </For>
            </div>
          )}
        </Show>
      </section>
    </div>
  )
}
