import {
  ANSWER_ERROR,
  CONDITION_MODES,
  catalogues,
  clampWorkflowSideWidth,
  conditionMode,
  type Edge,
  type MessageKey,
  NOTE_TEXT_MAX,
  NOTE_TONES,
  NOTIFY_TITLE_MAX,
  type Note,
  nodeNumbers,
  type RunStep,
  type Schedule,
  SILENT_CODE,
  STEP_EFFORTS,
  STEP_KINDS,
  type Step,
  type StepEffort,
  type StepKind,
  type Trigger,
  WORKFLOW_NOTES_MAX,
  WORKFLOW_SIDE_MAX,
  WORKFLOW_SIDE_MIN,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunDetail,
  workflowDiagram,
} from "@robot/shared"
import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { ChecklistCard, useChecklistRows } from "../imports/ImportChecklist.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { isForView } from "../lib/events.ts"
import { call } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { ScheduleFields } from "../routines/ScheduleFields.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { quietOfTaskLine } from "../state/quiet.ts"
import { useUi } from "../state/ui.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./workflows.module.css"

const NODE_W = 180
const NODE_H = 64
const NOTE_W = 200
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
    case "notify":
      return { ...base, kind, title: "" }
  }
}

/**
 * The state of a step of a run as text. While the turn of a running step is quiet, the quiet line
 * replaces "Running" (spec 005, "Quiet line"; 010).
 */
const StepStateText = (props: { step: Pick<RunStep, "state" | "taskId"> }) => {
  const { t } = useApp()
  const ui = useUi()
  const quiet = () =>
    props.step.state === "running"
      ? quietOfTaskLine(ui.linked() ? ui.server()?.id : undefined, props.step.taskId)
      : undefined
  return (
    <Show when={quiet()} fallback={t(`workflows.stepState.${props.step.state}` as MessageKey)}>
      {(q) => t("quiet.line", { name: q().name, time: q().time })}
    </Show>
  )
}

export const WorkflowEditor = (props: {
  workflow: Workflow | null
  onBack: () => void
  /**
   * True for a workflow that was just made from a starter (spec 010, "Starters"). Its graph is
   * wider than a narrow canvas, so the canvas opens with the whole graph in view. Any other
   * workflow opens at the usual place and size.
   */
  frame?: boolean
}) => {
  const { t } = useApp()
  const ui = useUi()
  /** The events of the server on screen only: runs that sync have the same id on both (012, 019). */
  const forView = (from: string | undefined) =>
    isForView(ui.linked() ? ui.server()?.id : undefined, from)
  const agents = useAgents()
  const channels = useChannels()
  const [saved, setSaved] = createSignal<Workflow | null>(props.workflow)
  const [name, setName] = createSignal(props.workflow?.name ?? "")
  const [trigger, setTrigger] = createSignal<Trigger>(props.workflow?.trigger ?? { kind: "manual" })
  const [scheduleOk, setScheduleOk] = createSignal(true)
  const [diagramOpen, setDiagramOpen] = createSignal(false)
  const [graph, setGraph] = createStore<{ steps: Step[]; edges: Edge[]; notes: Note[] }>({
    steps: props.workflow ? structuredClone([...props.workflow.steps]) : [],
    edges: props.workflow ? structuredClone([...props.workflow.edges]) : [],
    notes: props.workflow ? structuredClone([...props.workflow.notes]) : [],
  })
  const [selected, setSelected] = createSignal<{ kind: "step" | "edge" | "note"; id: string }>()
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
  let workspace: HTMLDivElement | undefined

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
    window.robot.on("workflows.run", ({ runId }, from) => {
      if (!forView(from)) return
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

  // The checklist that an import left for this workflow (spec 014). Its steps tick themselves as
  // the user picks on the canvas; "Turn on" ticks when the workflow is on.
  const checklistRows = useChecklistRows()
  // A checklist belongs to the import of this computer. A linked server has none here.
  const [checklist] = createResource(
    () => (ui.linked() ? undefined : saved()?.id),
    (workflowId) => call("checklists.forWorkflow", { workflowId }).catch(() => null),
  )
  const [enabled, { refetch: refetchEnabled }] = createResource(
    () => (checklist() ? { id: saved()?.id, serverId: ui.server()?.id } : undefined),
    async (input) =>
      input.id && input.serverId
        ? (await call("workflows.list", { serverId: input.serverId })).some(
            (w) => w.id === input.id && w.enabled,
          )
        : false,
  )
  onCleanup(
    window.robot.on("workflows.changed", (_payload, from) => {
      if (forView(from)) void refetchEnabled()
    }),
  )

  /** A linked server that does not let this device change agents shows the canvas read only (012). */
  const canEdit = () => ui.canChange()
  const readOnly = () => running() || !canEdit()
  const step = (id: string) => graph.steps.find((s) => s.id === id)
  const selectedStep = () => {
    const s = selected()
    return s?.kind === "step" ? step(s.id) : undefined
  }
  const selectedNote = () => {
    const s = selected()
    return s?.kind === "note" ? graph.notes.find((n) => n.id === s.id) : undefined
  }
  const numbers = () => nodeNumbers(graph.steps)

  const world = (event: { clientX: number; clientY: number }) => {
    const rect = canvas?.getBoundingClientRect()
    const v = view()
    return {
      x: (event.clientX - (rect?.left ?? 0) - v.x) / v.zoom,
      y: (event.clientY - (rect?.top ?? 0) - v.y) / v.zoom,
    }
  }

  /**
   * Puts the whole graph, notes too, in view: the zoom that fits it, never above 100% and never
   * below the lowest zoom. A graph that fits at 100% keeps the usual place and size.
   */
  const frameGraph = () => {
    const rect = canvas?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return
    const noteBoxes = canvas?.querySelectorAll<HTMLElement>('[data-testid="wf-note"]') ?? []
    const boxes = [
      ...graph.steps.map((s) => ({ x: s.x, y: s.y, w: NODE_W, h: NODE_H })),
      ...graph.notes.map((n, i) => ({
        x: n.x,
        y: n.y,
        w: NOTE_W,
        h: noteBoxes[i]?.offsetHeight ?? NODE_H,
      })),
    ]
    if (boxes.length === 0) return
    const left = Math.min(...boxes.map((b) => b.x))
    const top = Math.min(...boxes.map((b) => b.y))
    const width = Math.max(...boxes.map((b) => b.x + b.w)) - left
    const height = Math.max(...boxes.map((b) => b.y + b.h)) - top
    const margin = 24
    const zoom = Math.min(
      1,
      Math.max(
        ZOOM_MIN,
        Math.min((rect.width - 2 * margin) / width, (rect.height - 2 * margin) / height),
      ),
    )
    if (zoom >= 1) return
    setView({ zoom, x: margin - left * zoom, y: margin - top * zoom })
  }

  onMount(() => {
    if (props.frame) frameGraph()
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

  /** The side column grows when the handle moves left, because the handle is on its left edge. */
  const startSideResize = (event: PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = ui.ui.workflowSideWidth
    track(
      (e) =>
        ui.previewWorkflowSideWidth(
          clampWorkflowSideWidth(startWidth + startX - e.clientX, workspace?.clientWidth),
        ),
      () => ui.saveWorkflowSideWidth(),
    )
  }

  const sideResizeByKey = (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? 20 : event.key === "ArrowRight" ? -20 : 0
    if (!step) return
    event.preventDefault()
    ui.previewWorkflowSideWidth(
      clampWorkflowSideWidth(ui.ui.workflowSideWidth + step, workspace?.clientWidth),
    )
    ui.saveWorkflowSideWidth()
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

  const startDragNote = (id: string, event: PointerEvent) => {
    setSelected({ kind: "note", id })
    if (readOnly()) return
    const origin = graph.notes.find((n) => n.id === id)
    if (!origin) return
    const start = { x: event.clientX, y: event.clientY, nx: origin.x, ny: origin.y }
    const zoom = view().zoom
    track((e) =>
      setGraph("notes", (n) => n.id === id, {
        x: Math.round(start.nx + (e.clientX - start.x) / zoom),
        y: Math.round(start.ny + (e.clientY - start.y) / zoom),
      }),
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

  const addNote = () => {
    if (readOnly() || graph.notes.length >= WORKFLOW_NOTES_MAX) return
    const count = graph.notes.length
    const v = view()
    // A new note goes below the lowest step, in the part of the canvas that shows now.
    const top = (40 - v.y) / v.zoom
    const below = graph.steps.reduce((low, s) => Math.max(low, s.y + NODE_H + 30), top)
    const note: Note = {
      id: newId(),
      text: "",
      tone: "yellow",
      x: Math.round((40 - v.x) / v.zoom + (count % 3) * (NOTE_W + 30)),
      y: Math.round(below + Math.floor(count / 3) * 110),
    }
    setGraph("notes", (notes) => [...notes, note])
    setSelected({ kind: "note", id: note.id })
  }

  const patchNote = (id: string, patch: Partial<Note>) =>
    setGraph(
      "notes",
      (n) => n.id === id,
      produce((n: Note) => Object.assign(n, patch)),
    )

  const remove = () => {
    const s = selected()
    if (!s || readOnly()) return
    if (s.kind === "note") setGraph("notes", (notes) => notes.filter((n) => n.id !== s.id))
    else if (s.kind === "step") {
      setGraph("steps", (steps) => steps.filter((x) => x.id !== s.id))
      setGraph("edges", (edges) => edges.filter((e) => e.from !== s.id && e.to !== s.id))
    } else setGraph("edges", (edges) => edges.filter((e) => e.id !== s.id))
    setSelected(undefined)
  }

  /** Takes an optional field away, so that the step is saved without it. */
  const clearStepField = (id: string, field: "effort" | "provider") =>
    setGraph(
      "steps",
      (s) => s.id === id,
      produce((s: Step) => {
        delete (s as Record<string, unknown>)[field]
      }),
    )

  const patchStep = (id: string, patch: Partial<Step>) =>
    setGraph(
      "steps",
      (s) => s.id === id,
      produce((s: Step) => Object.assign(s, patch)),
    )

  /**
   * Saves the workflow. A failure always shows a toast. A success shows one only when the user
   * asked to save (`announce`), not when a run saves first.
   */
  const save = async (announce = false): Promise<Workflow | undefined> => {
    const serverId = ui.server()?.id
    if (!serverId) return
    setError(undefined)
    try {
      const body = {
        name: name().trim() || t("workflows.untitled"),
        trigger: trigger(),
        steps: plain(graph.steps),
        edges: plain(graph.edges),
        notes: plain(graph.notes),
      }
      const current = saved()
      const next = current
        ? await call("workflows.update", { id: current.id, patch: body })
        : await call("workflows.create", { serverId, ...body })
      setSaved(next)
      if (announce) showToast("success", "workflows.saved")
      return next
    } catch (e) {
      const problem = describeError(e)
      setError(problem)
      showToast("error", "workflows.saveFailed", { reason: t(problem.key, problem.params) })
    }
  }

  const run = async () => {
    // Without the switch the device runs the workflow as it is saved on the server (spec 012).
    const next = canEdit() ? await save() : saved()
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

  /** The reason a step failed, in words. A reason that has no text shows as it is. */
  const stepError = (reason: string): string => {
    if (reason.startsWith(`${ANSWER_ERROR}:`))
      return t("workflows.error.answer_not_yes_no", {
        answer: reason.slice(ANSWER_ERROR.length + 1).trim(),
      })
    // The silent limit keeps its number of minutes: "silent_limit:30".
    if (reason.startsWith(`${SILENT_CODE}:`))
      return t("error.silent_limit", { detail: reason.slice(SILENT_CODE.length + 1) })
    // A full queue keeps the name of the agent: "tasks_full:Ada".
    if (reason.startsWith("tasks_full:"))
      return t("error.tasks_full", { detail: reason.slice("tasks_full:".length) })
    for (const key of [`workflows.error.${reason}`, `error.${reason}`])
      if (key in catalogues.en) return t(key as MessageKey)
    return reason
  }

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
        <Show when={canEdit()}>
          <For each={STEP_KINDS}>
            {(k) => (
              <Button disabled={readOnly()} onClick={() => addStep(k)} data-testid={`wf-add-${k}`}>
                + {t(`workflows.step.${k}` as MessageKey)}
              </Button>
            )}
          </For>
          <Button
            disabled={readOnly() || graph.notes.length >= WORKFLOW_NOTES_MAX}
            onClick={addNote}
            data-testid="wf-add-note"
          >
            + {t("workflows.note.add")}
          </Button>
        </Show>
        <span class={styles.spacer} />
        <Button onClick={() => setDiagramOpen(true)} data-testid="wf-diagram">
          {t("workflows.diagram")}
        </Button>
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
        <Show when={canEdit()}>
          <Button
            disabled={readOnly() || !scheduleOk()}
            onClick={() => void save(true)}
            data-testid="wf-save"
          >
            {t("agents.save")}
          </Button>
        </Show>
        <Show
          when={running()}
          fallback={
            <Button
              variant="primary"
              // A workflow that runs on another computer through sync is not run here (019).
              disabled={(saved()?.runsOn ?? null) !== null}
              onClick={run}
              data-testid="wf-run"
            >
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

      <Show when={running()}>
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
                const current = trigger()
                if (current.kind === "schedule") setTrigger({ ...current, schedule })
              }}
            />
          </div>
        </Show>
        <Show
          when={(() => {
            const tr = trigger()
            return tr.kind === "manual" ? undefined : tr
          })()}
        >
          {(tr) => (
            <div class={styles.inline}>
              <Switch
                label={t("workflows.trigger.recordOnly")}
                checked={tr().recordOnly === true}
                disabled={readOnly()}
                onChange={(on) => {
                  const { recordOnly: _drop, ...rest } = tr()
                  setTrigger(on ? { ...rest, recordOnly: true } : rest)
                }}
                testId="wf-trigger-record-only"
              />
              <span>{t("workflows.trigger.recordOnly")}</span>
              <span class={styles.hint}>{t("workflows.trigger.recordOnlyHint")}</span>
            </div>
          )}
        </Show>
      </div>

      <Show when={checklist()}>
        {(list) => (
          <ChecklistCard
            testId="wf-checklist"
            place="canvas"
            rows={checklistRows(
              list(),
              {
                workflow: {
                  enabled: enabled.latest ?? false,
                  steps: graph.steps,
                  edges: graph.edges,
                },
              },
              (item) => {
                if (item.kind === "stepConnect") {
                  setSelected({ kind: "step", id: item.stepId })
                } else if (item.kind === "stepAgent" || item.kind === "stepPlace") {
                  setSelected({ kind: "step", id: item.stepId })
                  const field = item.kind === "stepAgent" ? "wf-step-agent" : "wf-step-channel"
                  queueMicrotask(() =>
                    document.querySelector<HTMLElement>(`[data-testid="${field}"]`)?.focus(),
                  )
                } else if (item.kind === "workflowOn") {
                  const id = saved()?.id
                  if (id) ui.reveal({ kind: "workflow", id })
                }
              },
            )}
          />
        )}
      </Show>

      <div
        class={styles.workspace}
        ref={workspace}
        style={{ "--side-width": `${ui.ui.workflowSideWidth}px` }}
        data-testid="wf-workspace"
      >
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
            <For each={graph.notes}>
              {(n) => (
                <div
                  class={styles.note}
                  style={{ left: `${n.x}px`, top: `${n.y}px`, width: `${NOTE_W}px` }}
                  data-tone={n.tone}
                  data-selected={selected()?.id === n.id}
                  data-testid="wf-note"
                  onPointerDown={(e) => startDragNote(n.id, e)}
                >
                  <span class={styles.noteText} data-empty={n.text === ""}>
                    {n.text || t("workflows.note.placeholder")}
                  </span>
                </div>
              )}
            </For>
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
                  <span
                    class={styles.nodeNumber}
                    title={t("workflows.node.number", { n: numbers().get(s.id) ?? 0 })}
                    data-testid="wf-node-number"
                  >
                    {numbers().get(s.id)}
                  </span>
                  <span class={styles.nodeKind}>
                    {t(`workflows.step.${s.kind}` as MessageKey)}
                    <Show when={s.kind === "agent" && s.agentId === ""}>
                      {" · "}
                      {t("workflows.step.pickAgent")}
                    </Show>
                    <Show when={s.kind === "post" && s.channelId === ""}>
                      {" · "}
                      {t("workflows.step.pickPlace")}
                    </Show>
                  </span>
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

        {/* biome-ignore lint/a11y/useSemanticElements: a focusable window splitter has no native element */}
        <div
          class={styles.resizer}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("workflows.resize")}
          aria-valuemin={WORKFLOW_SIDE_MIN}
          aria-valuemax={WORKFLOW_SIDE_MAX}
          aria-valuenow={ui.ui.workflowSideWidth}
          tabIndex={0}
          onPointerDown={startSideResize}
          onKeyDown={sideResizeByKey}
          data-testid="wf-resizer"
        />

        <div class={styles.side}>
          <aside class={styles.panel} data-testid="wf-panel">
            <Show
              when={selectedStep()}
              fallback={
                <Show
                  when={selectedNote()}
                  fallback={
                    <Show
                      when={selected()?.kind === "edge"}
                      fallback={<p class={styles.hint}>{t("workflows.panel.empty")}</p>}
                    >
                      <Show when={canEdit()}>
                        <Button disabled={readOnly()} onClick={remove} data-testid="wf-delete">
                          {t("workflows.deleteEdge")}
                        </Button>
                      </Show>
                    </Show>
                  }
                >
                  {(n) => (
                    <div class={styles.fields}>
                      <label class={styles.field}>
                        <span>{t("workflows.note.text")}</span>
                        <textarea
                          class={styles.input}
                          rows={6}
                          maxLength={NOTE_TEXT_MAX}
                          disabled={readOnly()}
                          value={n().text}
                          placeholder={t("workflows.note.placeholder")}
                          onInput={(e) => patchNote(n().id, { text: e.currentTarget.value })}
                          data-testid="wf-note-text"
                        />
                      </label>
                      <label class={styles.field}>
                        <span>{t("workflows.note.tone")}</span>
                        <select
                          class={styles.input}
                          disabled={readOnly()}
                          value={n().tone}
                          onChange={(e) =>
                            patchNote(n().id, { tone: e.currentTarget.value as Note["tone"] })
                          }
                          data-testid="wf-note-tone"
                        >
                          <For each={NOTE_TONES}>
                            {(tone) => (
                              <option value={tone}>
                                {t(`workflows.note.tone.${tone}` as MessageKey)}
                              </option>
                            )}
                          </For>
                        </select>
                      </label>
                      <span class={styles.hint}>{t("workflows.note.hint")}</span>
                      <Show when={canEdit()}>
                        <Button disabled={readOnly()} onClick={remove} data-testid="wf-note-delete">
                          {t("workflows.note.delete")}
                        </Button>
                      </Show>
                    </div>
                  )}
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
                            <option value="" selected={a().agentId === ""}>
                              {t("workflows.step.pickAgent")}
                            </option>
                            <For each={agents.agents()}>
                              {(x) => (
                                <option value={x.id} selected={x.id === a().agentId}>
                                  {x.name}
                                </option>
                              )}
                            </For>
                          </select>
                        </label>
                        <label class={styles.field}>
                          <span>{t("workflows.step.effort")}</span>
                          <select
                            class={styles.input}
                            disabled={readOnly()}
                            value={a().effort ?? ""}
                            onChange={(e) => {
                              const level = e.currentTarget.value as StepEffort | ""
                              // "Follow the agent" is the lack of a value, so the file stays small.
                              if (level === "") clearStepField(a().id, "effort")
                              else patchStep(a().id, { effort: level })
                            }}
                            data-testid="wf-step-effort"
                          >
                            <option value="" selected={a().effort === undefined}>
                              {t("workflows.step.effort.follow")}
                            </option>
                            <For each={STEP_EFFORTS}>
                              {(level) => (
                                <option value={level} selected={a().effort === level}>
                                  {t(`workflows.step.effort.${level}` as MessageKey)}
                                </option>
                              )}
                            </For>
                          </select>
                          <span class={styles.hint}>{t("workflows.step.effort.hint")}</span>
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
                      <>
                        <label class={styles.field}>
                          <span>{t("workflows.step.mode")}</span>
                          <select
                            class={styles.input}
                            disabled={readOnly()}
                            value={conditionMode(c())}
                            onChange={(e) =>
                              patchStep(c().id, {
                                mode: e.currentTarget.value as (typeof CONDITION_MODES)[number],
                              })
                            }
                            data-testid="wf-step-mode"
                          >
                            <For each={CONDITION_MODES}>
                              {(mode) => (
                                <option value={mode} selected={conditionMode(c()) === mode}>
                                  {t(`workflows.step.mode.${mode}` as MessageKey)}
                                </option>
                              )}
                            </For>
                          </select>
                        </label>
                        <label class={styles.field}>
                          <span>
                            {conditionMode(c()) === "ask"
                              ? t("workflows.step.question")
                              : t("workflows.step.contains")}
                          </span>
                          <input
                            class={styles.input}
                            disabled={readOnly()}
                            value={c().contains}
                            onInput={(e) => patchStep(c().id, { contains: e.currentTarget.value })}
                            data-testid="wf-step-contains"
                          />
                          <span class={styles.hint}>
                            {conditionMode(c()) === "ask"
                              ? t("workflows.step.question.hint")
                              : t("workflows.step.contains.hint")}
                          </span>
                        </label>
                        <Show when={conditionMode(c()) === "ask"}>
                          <label class={styles.field}>
                            <span>{t("workflows.step.provider")}</span>
                            <select
                              class={styles.input}
                              disabled={readOnly()}
                              value={c().provider ? "pick" : "auto"}
                              onChange={(e) => {
                                if (e.currentTarget.value === "pick")
                                  patchStep(c().id, { provider: { accountId: "", model: "" } })
                                else clearStepField(c().id, "provider")
                              }}
                              data-testid="wf-step-provider-mode"
                            >
                              <option value="auto" selected={!c().provider}>
                                {t("workflows.step.provider.auto")}
                              </option>
                              <option value="pick" selected={!!c().provider}>
                                {t("workflows.step.provider")}…
                              </option>
                            </select>
                          </label>
                          <Show when={c().provider}>
                            <ModelPicker
                              value={
                                c().provider?.accountId
                                  ? {
                                      ...(c().provider as { accountId: string; model: string }),
                                      effort: null,
                                    }
                                  : null
                              }
                              onChange={(m) =>
                                patchStep(c().id, {
                                  provider: m
                                    ? { accountId: m.accountId, model: m.model }
                                    : { accountId: "", model: "" },
                                })
                              }
                            />
                          </Show>
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show
                    when={
                      s().kind === "notify" ? (s() as Extract<Step, { kind: "notify" }>) : undefined
                    }
                  >
                    {(n) => (
                      <label class={styles.field}>
                        <span>{t("workflows.step.title")}</span>
                        <input
                          class={styles.input}
                          maxLength={NOTIFY_TITLE_MAX}
                          disabled={readOnly()}
                          value={n().title}
                          onInput={(e) => patchStep(n().id, { title: e.currentTarget.value })}
                          data-testid="wf-step-title"
                        />
                        <span class={styles.hint}>{t("workflows.step.notify.hint")}</span>
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
                    when={
                      s().kind === "post" ? (s() as Extract<Step, { kind: "post" }>) : undefined
                    }
                  >
                    {(p) => (
                      <>
                        <label class={styles.field}>
                          <span>{t("workflows.step.channel")}</span>
                          <select
                            class={styles.input}
                            disabled={readOnly()}
                            value={p().channelId}
                            onChange={(e) =>
                              patchStep(p().id, { channelId: e.currentTarget.value })
                            }
                            data-testid="wf-step-channel"
                          >
                            <option value="" selected={p().channelId === ""}>
                              {t("workflows.step.pickPlace")}
                            </option>
                            <For each={channels.channels()}>
                              {(c) => (
                                <option value={c.id} selected={c.id === p().channelId}>
                                  {c.name}
                                </option>
                              )}
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
                  <Show when={canEdit()}>
                    <Button disabled={readOnly()} onClick={remove} data-testid="wf-delete">
                      {t("workflows.deleteStep")}
                    </Button>
                  </Show>
                </div>
              )}
            </Show>
          </aside>

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
                    <Show when={r.startedBy}>
                      {(name) => (
                        <span class={styles.hint} data-testid="wf-run-started-by">
                          {t("workflows.startedBy", { name: name() })}
                        </span>
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <Show when={live()}>
              {(d) => (
                <div class={styles.runDetail} data-testid="wf-run-detail">
                  <Show when={d().run.state === "recorded"}>
                    <p class={styles.hint} data-testid="wf-run-recorded">
                      {t("workflows.recorded")}
                    </p>
                    <Show when={d().run.triggerText}>
                      {(text) => <pre data-testid="wf-run-trigger-text">{text()}</pre>}
                    </Show>
                  </Show>
                  <For each={d().steps}>
                    {(s) => (
                      <details
                        class={styles.stepRun}
                        data-state={s.state}
                        data-testid="wf-run-step"
                      >
                        <summary>
                          <span>{s.name}</span>
                          <span
                            class={styles.runState}
                            data-testid="wf-run-step-state"
                            data-state={s.state}
                          >
                            <StepStateText step={s} />
                          </span>
                        </summary>
                        <Show when={s.input}>
                          <div class={styles.hint}>{t("chat.tool.input")}</div>
                          <pre data-testid="wf-step-input">{s.input}</pre>
                        </Show>
                        <Show when={s.result}>
                          <div class={styles.hint}>{t("chat.tool.output")}</div>
                          <pre data-testid="wf-step-result">{s.result}</pre>
                        </Show>
                        <Show when={s.decidedBy}>
                          {(name) => (
                            <div class={styles.hint} data-testid="wf-step-decided-by">
                              {t(
                                s.error === "rejected"
                                  ? "chat.decision.denied"
                                  : "chat.decision.allowed",
                                { name: name() },
                              )}
                            </div>
                          )}
                        </Show>
                        <Show when={s.error}>
                          <pre class={styles.error} data-testid="wf-step-error">
                            {stepError(s.error)}
                          </pre>
                        </Show>
                      </details>
                    )}
                  </For>
                </div>
              )}
            </Show>
          </section>
        </div>
      </div>
      <Show when={diagramOpen()}>
        <Dialog
          label={t("workflows.diagram")}
          onClose={() => setDiagramOpen(false)}
          testId="wf-diagram-dialog"
        >
          <p class={styles.hint}>{t("workflows.diagram.hint")}</p>
          <pre class={styles.diagram} data-testid="wf-diagram-text">
            {workflowDiagram(graph.steps, graph.edges)}
          </pre>
          <div class={styles.actions}>
            <Button
              onClick={() =>
                void call("app.copy", { text: workflowDiagram(graph.steps, graph.edges) })
              }
              data-testid="wf-diagram-copy"
            >
              {t("workflows.diagram.copy")}
            </Button>
          </div>
        </Dialog>
      </Show>
    </div>
  )
}
