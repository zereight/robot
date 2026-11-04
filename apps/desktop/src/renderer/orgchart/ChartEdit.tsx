import type { Channel, ChartAgent, ChartChannel, MessageKey } from "@robot/shared"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { NewAgentDialog } from "../agents/AgentDialogs.tsx"
import { ChannelDialog } from "../channels/ChannelDialog.tsx"
import { describeError } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { useUi } from "../state/ui.tsx"
import { type MenuItem, PopupMenu } from "../ui/Menu.tsx"
import { Presence } from "../ui/Presence.tsx"
import {
  agentsFor,
  type Before,
  channelsFor,
  dropEdit,
  type Edit,
  leavingOf,
  planEdit,
  type Step,
  undoSteps,
} from "./edit.ts"
import styles from "./orgchart.module.css"

// Edit on the org chart (spec 029, "Edit on the chart"): the menus of the nodes, the drag of an
// agent node onto a channel node, and the line at the bottom of the canvas with "Undo". Every
// change is the change of the channel settings (004), so the server keeps the rules: a member that
// works cannot leave its channel, and a linked computer changes only with the switch "Can create
// and change agents" (012). Without the switch, the menus hold no change and there is no drag.

/** How long the line "<what changed>." with "Undo" shows. */
export const UNDO_MS = 10_000
/** A press that moves less than this is a click, not a drag. */
const DRAG_START_PX = 5

interface Notice {
  readonly kind: "done" | "refused"
  readonly text: string
  /** The channels as they were: set while "Undo" can put them back. */
  readonly before?: readonly Before[]
}

interface OpenMenu {
  readonly items: readonly MenuItem[]
  readonly label: string
  readonly top: number
  readonly left: number
  readonly opener: HTMLElement | undefined
}

/** The agent node that is dragged now, and the channel node under the pointer. */
export interface Dragging {
  readonly agentId: string
  readonly name: string
  /** The channel of the dragged copy, or null for "No channel". */
  readonly from: string | null
  readonly key: string
  readonly x: number
  readonly y: number
  /** The key of the channel node under the pointer. */
  readonly over: string | undefined
  /** Option is held: the agent is added and stays where it was. */
  readonly add: boolean
}

export const createChartEdit = (deps: {
  /** The channel node of a key, for the channel of a copy. */
  channelNode: (key: string) => ChartChannel | undefined
  openProfile: (agentId: string) => void
  openChannel: (channelId: string) => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const channels = useChannels()
  const canEdit = () => ui.canChange()

  /** The channels as the server has them now. The list of the window can be a moment late. */
  const fresh = async (): Promise<readonly Channel[]> => {
    const serverId = ui.server()?.id
    return serverId ? await call("channels.list", { serverId }) : channels.channels()
  }
  const agentName = (id: string) => agents.byId(id)?.name ?? ""
  const channelName = (list: readonly Channel[], id: string) =>
    list.find((c) => c.id === id)?.name ?? channels.byId(id)?.name ?? ""

  // ---------------------------------------------------------------- The line at the bottom
  const [notice, setNotice] = createSignal<Notice>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const show = (next: Notice | undefined) => {
    clearTimeout(timer)
    setNotice(next)
    if (next) timer = setTimeout(() => setNotice(undefined), UNDO_MS)
  }
  onCleanup(() => clearTimeout(timer))

  const doneText = (edit: Edit, list: readonly Channel[]) => {
    const name = agentName(edit.agentId)
    const channel = channelName(
      list,
      edit.kind === "add" || edit.kind === "move"
        ? edit.to
        : edit.kind === "remove"
          ? edit.from
          : edit.channelId,
    )
    const key: Record<Edit["kind"], MessageKey> = {
      add: "orgchart.done.added",
      move: "orgchart.done.moved",
      remove: "orgchart.done.removed",
      lead: "orgchart.done.lead",
      unlead: "orgchart.done.unlead",
    }
    return t(key[edit.kind], { name, channel })
  }

  /** The reason of a refusal. A member that works: "<agent> works in <channel>. …" */
  const refusal = (error: unknown, step: Step, list: readonly Channel[]) => {
    if (error instanceof RpcFailure && error.error.code === "member_working") {
      const leaving = leavingOf(step, list)
      const agentId = leaving?.agentIds[0]
      if (leaving && agentId)
        return t("orgchart.refused.works", {
          name: agentName(agentId),
          channel: channelName(list, leaving.channelId),
        })
    }
    const text = describeError(error)
    return t(text.key, text.params)
  }

  /** Sends the steps in order. A failure puts back the channels of the steps already made. */
  const run = async (
    steps: readonly Step[],
    list: readonly Channel[],
    before: readonly Before[],
  ) => {
    for (const [index, step] of steps.entries()) {
      try {
        await call("channels.update", { id: step.channelId, patch: step.patch })
      } catch (error) {
        if (index > 0) {
          const made = new Set(steps.slice(0, index).map((s) => s.channelId))
          const back = undoSteps(
            before.filter((b) => made.has(b.channelId)),
            await fresh().catch(() => list),
          )
          for (const s of back)
            await call("channels.update", { id: s.channelId, patch: s.patch }).catch(() => {})
        }
        show({ kind: "refused", text: refusal(error, step, list) })
        return false
      }
    }
    return true
  }

  let busy = false
  const apply = async (edit: Edit) => {
    if (busy || !canEdit()) return
    busy = true
    try {
      const list = await fresh()
      const plan = planEdit(edit, list)
      if (!plan) return
      if (await run(plan.steps, list, plan.before))
        show({ kind: "done", text: doneText(edit, list), before: plan.before })
    } catch (error) {
      show({ kind: "refused", text: refusal(error, { channelId: "", patch: {} }, []) })
    } finally {
      busy = false
    }
  }

  const undo = async () => {
    const shown = notice()
    if (busy || !shown?.before || !canEdit()) return
    busy = true
    show(undefined)
    try {
      const list = await fresh()
      const steps = undoSteps(shown.before, list)
      if (await run(steps, list, [])) show({ kind: "done", text: t("orgchart.undone") })
    } catch (error) {
      show({ kind: "refused", text: refusal(error, { channelId: "", patch: {} }, []) })
    } finally {
      busy = false
    }
  }

  // Cmd+Z does what "Undo" does while the line shows. A field of a dialog keeps its own Cmd+Z.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "z")
        return
      if (!notice()?.before || creating() || settingsOf()) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, [contenteditable=true]")) return
      event.preventDefault()
      void undo()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  // ---------------------------------------------------------------- Menus
  const [menu, setMenu] = createSignal<OpenMenu>()
  const [creating, setCreating] = createSignal<{ channelId: string | null }>()
  const [settingsOf, setSettingsOf] = createSignal<string>()

  const refocus = (el: HTMLElement | undefined) => {
    if (el?.isConnected) el.focus({ preventScroll: true })
  }
  /** The node whose menu was used. The focus goes back to it when the chart changes. */
  const [kept, setKept] = createSignal<string>()
  let opener: HTMLElement | undefined
  /** An item that runs an action gives the focus back to the node first. */
  const act = (label: string, run: () => void, testId: string): MenuItem => ({
    label,
    testId,
    onSelect: () => {
      refocus(opener)
      setKept(opener?.dataset.key)
      run()
    },
  })
  /** An item that opens a second list at the same place: a heading and one item for each choice. */
  const list = (label: string, testId: string, open: () => OpenMenu): MenuItem => ({
    label,
    testId,
    onSelect: () => queueMicrotask(() => setMenu(open())),
  })

  const channelList = (
    at: OpenMenu,
    title: string,
    agentId: string,
    pick: (channelId: string) => Edit,
    testId: string,
  ): OpenMenu => {
    const targets = channelsFor(agentId, channels.channels())
    return {
      ...at,
      label: title,
      items: [
        { label: title, heading: true, onSelect: () => {} },
        ...(targets.length > 0
          ? targets.map((c) => act(c.name, () => void apply(pick(c.id)), `${testId}-${c.id}`))
          : [{ label: t("orgchart.edit.noChannels"), disabled: true, onSelect: () => {} }]),
      ],
    }
  }

  /** The menu of an agent node. The root has "Open profile" only. */
  const agentMenu = (node: ChartAgent, isRoot: boolean, at: Omit<OpenMenu, "items" | "label">) => {
    const label = t("orgchart.edit.menu", { name: node.name })
    const items: MenuItem[] = [
      act(t("orgchart.edit.openProfile"), () => deps.openProfile(node.agentId), "org-menu-profile"),
    ]
    const base: OpenMenu = { ...at, label, items }
    if (isRoot || !canEdit()) return base
    const channelId = deps.channelNode(node.parent)?.channelId ?? null
    const name = node.name
    if (channelId) {
      const channel = channelName(channels.channels(), channelId)
      items.push(
        node.isLead
          ? act(
              t("orgchart.edit.removeLead"),
              () => void apply({ kind: "unlead", agentId: node.agentId, channelId }),
              "org-menu-unlead",
            )
          : act(
              t("orgchart.edit.makeLead", { channel }),
              () => void apply({ kind: "lead", agentId: node.agentId, channelId }),
              "org-menu-lead",
            ),
      )
    }
    items.push(
      list(t("orgchart.edit.addTo"), "org-menu-add", () =>
        channelList(
          base,
          t("orgchart.edit.addToTitle", { name }),
          node.agentId,
          (to) => ({ kind: "add", agentId: node.agentId, to }),
          "org-menu-add-to",
        ),
      ),
    )
    if (channelId) {
      items.push(
        list(t("orgchart.edit.moveTo"), "org-menu-move", () =>
          channelList(
            base,
            t("orgchart.edit.moveToTitle", { name }),
            node.agentId,
            (to) => ({ kind: "move", agentId: node.agentId, from: channelId, to }),
            "org-menu-move-to",
          ),
        ),
        act(
          t("orgchart.edit.removeFrom", { channel: channelName(channels.channels(), channelId) }),
          () => void apply({ kind: "remove", agentId: node.agentId, from: channelId }),
          "org-menu-remove",
        ),
      )
    }
    return base
  }

  /** The menu of a channel node. "No channel" has "New agent" only. */
  const channelMenu = (node: ChartChannel, at: Omit<OpenMenu, "items" | "label">) => {
    const channelId = node.channelId
    const label = t("orgchart.edit.menu", { name: node.name || t("orgchart.noChannel") })
    if (!channelId) {
      const items = canEdit()
        ? [
            act(
              t("orgchart.edit.newAgent"),
              () => setCreating({ channelId: null }),
              "org-menu-new-agent",
            ),
          ]
        : []
      return { ...at, label, items }
    }
    const items: MenuItem[] = [
      act(t("orgchart.edit.openChannel"), () => deps.openChannel(channelId), "org-menu-channel"),
    ]
    const base: OpenMenu = { ...at, label, items }
    if (!canEdit()) return base
    items.push(
      list(t("orgchart.edit.addMember"), "org-menu-add-member", () => {
        const channel = channels.byId(channelId) ?? {
          id: channelId,
          name: node.name,
          leadId: null,
          memberIds: [],
        }
        const choices = agentsFor(channel, agents.agents())
        const title = t("orgchart.edit.addMemberTitle", { channel: node.name })
        return {
          ...base,
          label: title,
          items: [
            { label: title, heading: true, onSelect: () => {} },
            ...(choices.length > 0
              ? choices.map((a) =>
                  act(
                    a.name,
                    () => void apply({ kind: "add", agentId: a.id, to: channelId }),
                    `org-menu-member-${a.id}`,
                  ),
                )
              : [{ label: t("orgchart.edit.noAgents"), disabled: true, onSelect: () => {} }]),
          ],
        }
      }),
      act(t("orgchart.edit.newAgentHere"), () => setCreating({ channelId }), "org-menu-new-agent"),
      act(t("orgchart.edit.settings"), () => setSettingsOf(channelId), "org-menu-settings"),
    )
    return base
  }

  /** True when the node has a menu: every node but "You", and "No channel" only with the switch. */
  const hasMenu = (node: ChartChannel | ChartAgent | undefined) =>
    node !== undefined && ("agentId" in node || node.channelId !== null || canEdit())

  const at = (from: HTMLElement, point?: { x: number; y: number }) => {
    opener = from
    const r = from.getBoundingClientRect()
    return { top: point?.y ?? r.bottom + 4, left: point?.x ?? r.left, opener: from }
  }
  const openAgentMenu = (
    node: ChartAgent,
    isRoot: boolean,
    opener: HTMLElement,
    point?: { x: number; y: number },
  ) => {
    setKept(undefined)
    setMenu(agentMenu(node, isRoot, at(opener, point)))
  }
  const openChannelMenu = (
    node: ChartChannel,
    opener: HTMLElement,
    point?: { x: number; y: number },
  ) => {
    setKept(undefined)
    const next = channelMenu(node, at(opener, point))
    if (next.items.length > 0) setMenu(next)
  }

  /** The menu key or Shift+F10 opens the menu of the focused node. */
  const isMenuKey = (event: KeyboardEvent) =>
    event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")

  // ---------------------------------------------------------------- Drag
  const [dragging, setDragging] = createSignal<Dragging>()
  let press:
    | {
        pointerId: number
        x: number
        y: number
        agentId: string
        name: string
        from: string | null
        key: string
      }
    | undefined
  /** A drag ends with a click on the node where it began. That click opens nothing. */
  let swallowClick = false

  const overAt = (x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-node][data-kind="channel"]')
      ?.dataset.key ?? undefined

  const targetOf = (drag: Dragging, key: string | undefined) => {
    if (!key) return undefined
    const node = deps.channelNode(key)
    if (!node) return undefined
    return dropEdit(
      { agentId: drag.agentId, from: drag.from, to: node.channelId, add: drag.add },
      channels.channels(),
    )
  }
  /** During a drag, a channel node where a drop is allowed shows a ring. */
  const ringOf = (key: string) => {
    const drag = dragging()
    return drag !== undefined && targetOf(drag, key) !== undefined
  }

  const endDrag = () => {
    press = undefined
    setDragging(undefined)
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onCancel)
    window.removeEventListener("keydown", onDragKey, true)
    window.removeEventListener("keyup", onDragKey, true)
  }
  const onMove = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.pointerId) return
    const drag = dragging()
    if (!drag) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_START_PX) return
      setMenu(undefined)
    }
    setDragging({
      agentId: press.agentId,
      name: press.name,
      from: press.from,
      key: press.key,
      x: event.clientX,
      y: event.clientY,
      over: overAt(event.clientX, event.clientY),
      add: event.altKey,
    })
  }
  const onUp = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.pointerId) return
    const drag = dragging()
    endDrag()
    if (!drag) return
    swallowClick = true
    // A drop where no ring shows, or on the empty canvas, changes nothing.
    const edit = targetOf({ ...drag, add: event.altKey }, overAt(event.clientX, event.clientY))
    if (edit) void apply(edit)
  }
  const onCancel = () => endDrag()
  // Option can go down or up during a drag. Escape ends the drag with no change.
  const onDragKey = (event: KeyboardEvent) => {
    const drag = dragging()
    if (event.key === "Escape" && event.type === "keydown" && press) {
      event.preventDefault()
      event.stopPropagation()
      if (drag) swallowClick = true
      endDrag()
      return
    }
    if (drag && event.key === "Alt") setDragging({ ...drag, add: event.type === "keydown" })
  }

  /** A press on an agent node in a channel node: it may become a drag. */
  const pressAgent = (event: PointerEvent, node: ChartAgent) => {
    swallowClick = false
    if (event.button !== 0 || !canEdit() || press) return
    const from = deps.channelNode(node.parent)
    if (!from) return
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      agentId: node.agentId,
      name: node.name,
      from: from.channelId,
      key: node.key,
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("keydown", onDragKey, true)
    window.addEventListener("keyup", onDragKey, true)
  }
  onCleanup(endDrag)
  /** True once: the click that ends a drag. */
  const takeClick = () => {
    const was = swallowClick
    swallowClick = false
    return was
  }

  // ---------------------------------------------------------------- What the page draws
  const Overlays = () => (
    <>
      <Show when={menu()} keyed>
        {(open) => (
          <PopupMenu
            items={open.items}
            top={open.top}
            left={open.left}
            label={open.label}
            testId="org-menu"
            onClose={(back) => {
              setMenu(undefined)
              if (back) refocus(open.opener)
            }}
          />
        )}
      </Show>
      <Show when={dragging()}>
        {(drag) => (
          <div
            class={styles.ghost}
            style={{ left: `${drag().x + 12}px`, top: `${drag().y + 12}px` }}
            data-testid="org-drag-ghost"
            aria-hidden="true"
          >
            {drag().name}
          </div>
        )}
      </Show>
      <Presence when={creating()}>
        {(target) => (
          <NewAgentDialog
            onClose={() => setCreating(undefined)}
            onCreated={async (agent) => {
              if (!target.channelId) return
              const current = (await fresh()).find((c) => c.id === target.channelId)
              if (!current) return
              await call("channels.update", {
                id: current.id,
                patch: { memberIds: [...current.memberIds, agent.id] },
              })
            }}
          />
        )}
      </Presence>
      <Presence when={settingsOf()}>
        {(id) => (
          <Show when={channels.byId(id)}>
            {(channel) => (
              <ChannelDialog channel={channel()} onClose={() => setSettingsOf(undefined)} />
            )}
          </Show>
        )}
      </Presence>
    </>
  )

  /** The line at the bottom of the canvas. */
  const NoticeLine = () => (
    <Show when={notice()}>
      {(n) => (
        <div
          class={styles.notice}
          role="status"
          data-kind={n().kind}
          data-control=""
          data-testid="org-notice"
        >
          <span class={styles.noticeText} data-testid="org-notice-text">
            {n().text}
          </span>
          <Show when={n().before}>
            <button
              type="button"
              class={styles.undo}
              onClick={() => void undo()}
              data-testid="org-undo"
            >
              {t("orgchart.undo")}
            </button>
          </Show>
        </div>
      )}
    </Show>
  )

  return {
    canEdit,
    menuOpen: () => menu() !== undefined,
    /** The key of the node to give the focus back to after a change from its menu. */
    kept,
    dropKept: () => setKept(undefined),
    hasMenu,
    openAgentMenu,
    openChannelMenu,
    isMenuKey,
    dragging,
    ringOf,
    pressAgent,
    takeClick,
    Overlays,
    NoticeLine,
  }
}

export type ChartEdit = ReturnType<typeof createChartEdit>
