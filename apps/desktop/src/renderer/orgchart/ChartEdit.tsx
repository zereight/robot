import {
  type Agent,
  type ChartAgent,
  type ChartOrg,
  type MessageKey,
  type Org,
  ROOT_KEY,
} from "@robot/shared"
import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { NewAgentDialog } from "../agents/AgentDialogs.tsx"
import { describeError } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { NEW_ORG, OrgDialog } from "../orgs/OrgDialog.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useOrgs } from "../state/orgs.tsx"
import { useUi } from "../state/ui.tsx"
import { type MenuItem, PopupMenu } from "../ui/Menu.tsx"
import { Presence } from "../ui/Presence.tsx"
import {
  agentsFor,
  type Before,
  dropEdit,
  type Edit,
  type NoticeKind,
  noticeMs,
  orgDropEdit,
  orgsFor,
  parentChoices,
  planEdit,
  type Step,
  undoSteps,
} from "./edit.ts"
import styles from "./orgchart.module.css"

// Edit on the org chart (spec 029, "Edit on the chart"): the menus of the nodes, the drag of an
// agent node onto an organization node, the drag of an organization node onto an organization node
// or the root (030), the form of an organization, and the line at the bottom of the canvas with
// "Undo". Every change is the change of the form of an organization (030), so the server keeps the
// rules: the tree has no loop and at most 3 levels, and a linked computer changes only with the
// switch "Can create and change agents" (012). Without the switch, the menus hold no change and
// there is no drag. An agent that works can change its organizations: membership holds no running
// work.

/** A press that moves less than this is a click, not a drag. */
const DRAG_START_PX = 5
/** The key of the drop area "No organization" that shows during a drag. It is no node of the layout. */
export const DROP_AREA_KEY = "drop:none"

interface Notice {
  readonly kind: NoticeKind
  readonly text: string
  /** The organizations as they were: set while "Undo" can put them back. A refusal has none. */
  readonly before?: readonly Before[]
}

interface OpenMenu {
  readonly items: readonly MenuItem[]
  readonly label: string
  readonly top: number
  readonly left: number
  readonly opener: HTMLElement | undefined
}

/** The node that is dragged now, and the node under the pointer. */
export interface Dragging {
  /** Set for the drag of an organization node: the organization that moves in the tree (spec 030). */
  readonly orgId?: string
  /** The agent of a dragged agent node. Empty for an organization node. */
  readonly agentId: string
  readonly name: string
  /** The organization of the dragged copy, or null for "No organization". */
  readonly from: string | null
  readonly key: string
  readonly x: number
  readonly y: number
  /** The key of the organization node (or the root, or the drop area) under the pointer. */
  readonly over: string | undefined
  /** Option is held: the agent is added and stays where it was. */
  readonly add: boolean
}

export const createChartEdit = (deps: {
  /** The organization node of a key, for the organization of a copy. */
  orgNode: (key: string) => ChartOrg | undefined
  openProfile: (agentId: string) => void
  /** After "New agent" or "New agent in this organization": the focus goes to the node of the agent. */
  focusAgent: (agentId: string, orgId: string | null) => void
  /** After "New organization" is saved: the focus goes to its node. */
  focusOrg: (orgId: string) => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const orgs = useOrgs()
  const canEdit = () => ui.canChange()

  /** The organizations as the server has them now. The list of the window can be a moment late. */
  const fresh = async (): Promise<readonly Org[]> => {
    const serverId = ui.server()?.id
    return serverId ? await call("organizations.list", { serverId }) : orgs.orgs()
  }
  const agentName = (id: string) => agents.byId(id)?.name ?? ""
  // The rule "One line" counts the archived agents too (spec 030). The list "Put under…" names the
  // agent whose line it would split, so the chart reads the archived agents as well.
  const [archivedAgents] = createResource(
    () => [ui.server()?.id, agents.agents().length] as const,
    ([serverId]) =>
      serverId ? call("agents.list", { serverId, archived: true }).catch((): Agent[] => []) : [],
  )
  const lineAgents = () => [...agents.agents(), ...(archivedAgents() ?? [])]
  const orgName = (list: readonly Org[], id: string) =>
    list.find((o) => o.id === id)?.name ?? orgs.byId(id)?.name ?? ""

  // ---------------------------------------------------------------- The line at the bottom
  // One line shows at a time: a new line takes the place of the line that shows, with its own time.
  const [notice, setNotice] = createSignal<Notice>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const show = (next: Notice | undefined) => {
    clearTimeout(timer)
    setNotice(next)
    if (next) timer = setTimeout(() => setNotice(undefined), noticeMs(next.kind))
  }
  onCleanup(() => clearTimeout(timer))

  // The app repaired the tree or a line: the open chart says so for 10 seconds (spec 030, "Repair"). It is
  // no change of the user, so it has no "Undo". The event comes from this computer only.
  onCleanup(
    window.robot.on("organizations.repaired", (repair) => {
      if (repair.serverId !== ui.server()?.id) return
      const { name } = repair
      show({
        kind: "refused",
        text:
          repair.reason === "line"
            ? t("orgchart.repaired.line", {
                agent: repair.agentName,
                organization: name,
                other: repair.otherName,
              })
            : t(repair.reason === "loop" ? "orgchart.repaired.loop" : "orgchart.repaired.levels", {
                name,
              }),
      })
    }),
  )

  const doneText = (edit: Edit, list: readonly Org[]) => {
    if (edit.kind === "parent") {
      const organization = orgName(list, edit.orgId)
      return edit.parentId === null
        ? t("orgchart.done.toTop", { organization })
        : t("orgchart.done.putUnder", { organization, parent: orgName(list, edit.parentId) })
    }
    const name = agentName(edit.agentId)
    const organization = orgName(
      list,
      edit.kind === "add" || edit.kind === "move"
        ? edit.to
        : edit.kind === "remove"
          ? edit.from
          : edit.orgId,
    )
    const key: Record<Exclude<Edit["kind"], "parent">, MessageKey> = {
      add: "orgchart.done.added",
      move: "orgchart.done.moved",
      remove: "orgchart.done.removed",
      lead: "orgchart.done.lead",
      unlead: "orgchart.done.unlead",
    }
    return t(key[edit.kind], { name, organization })
  }

  /** The reason of a refusal: the text of the error. */
  const refusal = (error: unknown) => {
    const text = describeError(error)
    return t(text.key, text.params)
  }

  /** Sends the steps in order. A failure puts back the organizations of the steps already made. */
  const run = async (steps: readonly Step[], list: readonly Org[], before: readonly Before[]) => {
    for (const [index, step] of steps.entries()) {
      try {
        await call("organizations.update", { id: step.orgId, patch: step.patch })
      } catch (error) {
        if (index > 0) {
          const made = new Set(steps.slice(0, index).map((s) => s.orgId))
          const back = undoSteps(
            before.filter((b) => made.has(b.orgId)),
            await fresh().catch(() => list),
          )
          if ("steps" in back)
            for (const s of back.steps)
              await call("organizations.update", { id: s.orgId, patch: s.patch }).catch(() => {})
        }
        show({ kind: "refused", text: refusal(error) })
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
      show({ kind: "refused", text: refusal(error) })
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
      const back = undoSteps(shown.before, list)
      // The change cannot go back when an organization of it was deleted in the meantime.
      if ("gone" in back) {
        show({ kind: "refused", text: t("orgchart.refused.gone", { name: back.gone }) })
        return
      }
      if (await run(back.steps, list, [])) show({ kind: "undone", text: t("orgchart.undone") })
    } catch (error) {
      show({ kind: "refused", text: refusal(error) })
    } finally {
      busy = false
    }
  }

  // Cmd+Z does what "Undo" does while the line shows. A field of a dialog keeps its own Cmd+Z.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "z")
        return
      if (!notice()?.before || creating() || formOf()) return
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
  const [creating, setCreating] = createSignal<{ orgId: string | null }>()
  /** The form of an organization that is open: an id, or `NEW_ORG`. */
  const [formOf, setFormOf] = createSignal<string>()

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

  const orgList = (
    at: OpenMenu,
    title: string,
    agentId: string,
    pick: (orgId: string) => Edit,
    testId: string,
    leavingId?: string,
  ): OpenMenu => {
    const targets = orgsFor(agentId, orgs.orgs(), leavingId)
    return {
      ...at,
      label: title,
      items: [
        { label: title, heading: true, onSelect: () => {} },
        ...(targets.length > 0
          ? targets.map((o) => ({
              ...act(o.name, () => void apply(pick(o.id)), `${testId}-${o.id}`),
              // The rule "One line" (spec 030): muted, with the organization that keeps the agent out.
              ...(o.conflict !== undefined
                ? { disabled: true, reason: t("orgs.line.notWith", { other: o.conflict }) }
                : {}),
            }))
          : [{ label: t("orgchart.edit.noOrganizations"), disabled: true, onSelect: () => {} }]),
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
    const orgId = deps.orgNode(node.parent)?.orgId ?? null
    const name = node.name
    if (orgId) {
      const organization = orgName(orgs.orgs(), orgId)
      items.push(
        node.isLead
          ? act(
              t("orgchart.edit.removeLead"),
              () => void apply({ kind: "unlead", agentId: node.agentId, orgId }),
              "org-menu-unlead",
            )
          : act(
              t("orgchart.edit.makeLead", { organization }),
              () => void apply({ kind: "lead", agentId: node.agentId, orgId }),
              "org-menu-lead",
            ),
      )
    }
    items.push(
      list(t("orgchart.edit.addTo"), "org-menu-add", () =>
        orgList(
          base,
          t("orgchart.edit.addToTitle", { name }),
          node.agentId,
          (to) => ({ kind: "add", agentId: node.agentId, to }),
          "org-menu-add-to",
        ),
      ),
    )
    if (orgId) {
      items.push(
        list(t("orgchart.edit.moveTo"), "org-menu-move", () =>
          orgList(
            base,
            t("orgchart.edit.moveToTitle", { name }),
            node.agentId,
            (to) => ({ kind: "move", agentId: node.agentId, from: orgId, to }),
            "org-menu-move-to",
            orgId,
          ),
        ),
        act(
          t("orgchart.edit.removeFrom", { organization: orgName(orgs.orgs(), orgId) }),
          () => void apply({ kind: "remove", agentId: node.agentId, from: orgId }),
          "org-menu-remove",
        ),
      )
    }
    return base
  }

  /** The menu of an organization node. "No organization" has "New agent" only. */
  const orgMenu = (node: ChartOrg, at: Omit<OpenMenu, "items" | "label">) => {
    const orgId = node.orgId
    const label = t("orgchart.edit.menu", { name: node.name || t("orgchart.noOrganization") })
    if (!orgId) {
      const items = canEdit()
        ? [
            act(
              t("orgchart.edit.newAgent"),
              () => setCreating({ orgId: null }),
              "org-menu-new-agent",
            ),
          ]
        : []
      return { ...at, label, items }
    }
    // The form opens on every computer. Without the switch "Can create and change agents" it is
    // read only (spec 012).
    const items: MenuItem[] = [
      act(t("orgchart.edit.editOrg"), () => setFormOf(orgId), "org-menu-edit-org"),
    ]
    const base: OpenMenu = { ...at, label, items }
    if (!canEdit()) return base
    items.push(
      list(t("orgchart.edit.addMember"), "org-menu-add-member", () => {
        const org = orgs.byId(orgId) ?? { id: orgId, name: node.name, leadId: null, memberIds: [] }
        const choices = agentsFor(org, agents.agents(), orgs.orgs())
        const title = t("orgchart.edit.addMemberTitle", { organization: node.name })
        return {
          ...base,
          label: title,
          items: [
            { label: title, heading: true, onSelect: () => {} },
            ...(choices.length > 0
              ? choices.map((a) => ({
                  ...act(
                    a.name,
                    () => void apply({ kind: "add", agentId: a.id, to: orgId }),
                    `org-menu-member-${a.id}`,
                  ),
                  ...(a.conflict !== undefined
                    ? { disabled: true, reason: t("orgs.line.in", { other: a.conflict }) }
                    : {}),
                }))
              : [{ label: t("orgchart.edit.noAgents"), disabled: true, onSelect: () => {} }]),
          ],
        }
      }),
      act(t("orgchart.edit.newAgentHere"), () => setCreating({ orgId }), "org-menu-new-agent"),
      // The tree (spec 030): "Put under…" lists the organizations of the field "Parent
      // organization", without the parent now. One that the rules refuse is muted, with the
      // reason. A sub-organization has "Move to the top".
      list(t("orgchart.edit.putUnder"), "org-menu-put-under", () => {
        const choices = parentChoices(orgId, orgs.orgs(), lineAgents())
        const title = t("orgchart.edit.putUnderTitle", { organization: node.name })
        return {
          ...base,
          label: title,
          items: [
            { label: title, heading: true, onSelect: () => {} },
            ...(choices.length > 0
              ? choices.map((c) => ({
                  ...act(
                    c.name,
                    () => void apply({ kind: "parent", orgId, parentId: c.id }),
                    `org-menu-under-${c.id}`,
                  ),
                  ...(c.refusal
                    ? {
                        disabled: true,
                        reason: t(c.refusal === "loop" ? "orgs.parent.loop" : "orgs.parent.levels"),
                      }
                    : c.split !== undefined
                      ? { disabled: true, reason: t("orgs.line.split", { agent: c.split }) }
                      : {}),
                }))
              : [{ label: t("orgchart.edit.noParents"), disabled: true, onSelect: () => {} }]),
          ],
        }
      }),
      ...(node.parentKey !== null
        ? [
            act(
              t("orgchart.edit.toTop"),
              () => void apply({ kind: "parent", orgId, parentId: null }),
              "org-menu-to-top",
            ),
          ]
        : []),
    )
    return base
  }

  /** True when the node has a menu: every node but "You", and "No organization" only with the switch. */
  const hasMenu = (node: ChartOrg | ChartAgent | undefined) =>
    node !== undefined && ("agentId" in node || node.orgId !== null || canEdit())

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
  const openOrgMenu = (node: ChartOrg, opener: HTMLElement, point?: { x: number; y: number }) => {
    setKept(undefined)
    const next = orgMenu(node, at(opener, point))
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
        orgId?: string
        agentId: string
        name: string
        from: string | null
        key: string
      }
    | undefined
  /** A drag ends with a click on the node where it began. That click opens nothing. */
  let swallowClick = false

  /** The drop area "No organization", or the key of the organization node under the point. */
  const overAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)
    if (el?.closest("[data-drop-area]")) return DROP_AREA_KEY
    if (el?.closest('[data-node][data-kind="root"]')) return ROOT_KEY
    return el?.closest<HTMLElement>('[data-node][data-kind="org"]')?.dataset.key ?? undefined
  }

  const targetOf = (drag: Dragging, key: string | undefined) => {
    if (!key) return undefined
    // An organization node: onto another organization node it goes under it, onto the root to the top.
    if (drag.orgId) {
      if (key === ROOT_KEY) return orgDropEdit(drag.orgId, null, orgs.orgs())
      const to = deps.orgNode(key)?.orgId
      return to ? orgDropEdit(drag.orgId, to, orgs.orgs()) : undefined
    }
    if (key === ROOT_KEY) return undefined
    // The drop area does what a drop on the organization node "No organization" does.
    if (key === DROP_AREA_KEY)
      return dropEdit(
        { agentId: drag.agentId, from: drag.from, to: null, add: drag.add },
        orgs.orgs(),
      )
    const node = deps.orgNode(key)
    if (!node) return undefined
    return dropEdit(
      { agentId: drag.agentId, from: drag.from, to: node.orgId, add: drag.add },
      orgs.orgs(),
    )
  }
  /** During a drag, an organization node where a drop is allowed shows a ring. */
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
      ...(press.orgId ? { orgId: press.orgId } : {}),
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
    // A drop where no ring shows, or on the empty canvas, changes nothing. The target is found
    // before the drag ends: the end takes away the drop area "No organization".
    const edit = drag
      ? targetOf({ ...drag, add: event.altKey }, overAt(event.clientX, event.clientY))
      : undefined
    endDrag()
    if (!drag) return
    swallowClick = true
    if (edit) void apply(edit)
  }
  const onCancel = () => endDrag()
  /** The view moved under a pointer that stays: the node under the pointer can change. */
  const pointerStays = () => {
    const drag = dragging()
    if (!drag) return
    const over = overAt(drag.x, drag.y)
    if (over !== drag.over) setDragging({ ...drag, over })
  }
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

  /** A press on an agent node in an organization node: it may become a drag. */
  const pressAgent = (event: PointerEvent, node: ChartAgent) => {
    swallowClick = false
    if (event.button !== 0 || !canEdit() || press) return
    const from = deps.orgNode(node.parent)
    if (!from) return
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      agentId: node.agentId,
      name: node.name,
      from: from.orgId,
      key: node.key,
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("keydown", onDragKey, true)
    window.addEventListener("keyup", onDragKey, true)
  }
  /** A press on an organization node (not "No organization"): it may become a drag in the tree (spec 030). */
  const pressOrg = (event: PointerEvent, node: ChartOrg) => {
    swallowClick = false
    if (event.button !== 0 || !canEdit() || press || !node.orgId) return
    press = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      orgId: node.orgId,
      agentId: "",
      name: node.name,
      // The drop area "No organization" is for agents only.
      from: null,
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
            stay
            onClose={() => setCreating(undefined)}
            onCreated={async (agent) => {
              // The chart stays open, the profile does not open, and the focus goes to the node of
              // the new agent once the chart shows it.
              deps.focusAgent(agent.id, target.orgId)
              if (!target.orgId) return
              // The agent is made but cannot join the organization: the refusal line gives the
              // reason, and the focus goes to its node in "No organization".
              const cannotJoin = (error: unknown) => {
                show({
                  kind: "refused",
                  text: t("orgchart.refused.join", { name: agent.name, reason: refusal(error) }),
                })
                deps.focusAgent(agent.id, null)
              }
              try {
                const current = (await fresh()).find((o) => o.id === target.orgId)
                if (!current) {
                  cannotJoin(new RpcFailure({ code: "org_not_found", message: target.orgId }))
                  return
                }
                await call("organizations.update", {
                  id: current.id,
                  patch: { memberIds: [...current.memberIds, agent.id] },
                })
              } catch (error) {
                cannotJoin(error)
              }
            }}
          />
        )}
      </Presence>
      <Presence when={formOf()}>
        {(id) => (
          <OrgDialog
            id={id}
            onClose={() => setFormOf(undefined)}
            onSaved={(org) => deps.focusOrg(org.id)}
          />
        )}
      </Presence>
    </>
  )

  /**
   * During the drag of an agent node that is in an organization: the drop area "No organization" at the
   * bottom left of the canvas, over the chart and the controls. It stays in place when the view
   * moves, and goes when the drag ends.
   */
  const DropArea = () => (
    <Show when={dragging()?.from != null}>
      <div
        class={styles.dropArea}
        data-drop-area=""
        data-control=""
        data-ring={ringOf(DROP_AREA_KEY)}
        data-over={dragging()?.over === DROP_AREA_KEY}
        data-testid="org-drop-area"
        aria-hidden="true"
      >
        {t("orgchart.noOrganization")}
      </div>
    </Show>
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
    /** True while the form of a new agent is open. */
    creating: () => creating() !== undefined,
    /** True while the form of an organization is open. */
    creatingOrg: () => formOf() !== undefined,
    /** A click on an organization node: its form (spec 029, 030). */
    openOrg: (id: string) => setFormOf(id),
    /** The button "New organization": the form of a new one. */
    newOrg: () => setFormOf(NEW_ORG),
    /** The key of the node to give the focus back to after a change from its menu. */
    kept,
    dropKept: () => setKept(undefined),
    hasMenu,
    openAgentMenu,
    openOrgMenu,
    isMenuKey,
    dragging,
    ringOf,
    pointerStays,
    pressAgent,
    pressOrg,
    takeClick,
    Overlays,
    NoticeLine,
    DropArea,
  }
}

export type ChartEdit = ReturnType<typeof createChartEdit>
