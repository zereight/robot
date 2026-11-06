import {
  type AgentView,
  builtInSection,
  listPage,
  type MoveDirection,
  NARROW_WIDTH,
  type OrgView,
  type Page,
  type PlaceKind,
  type PlaceRef,
  type PlaceSection,
  type Server,
  type UiState,
  type UiStatePatch,
} from "@robot/shared"
import {
  createComputed,
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { call, setActiveServer } from "../lib/rpc.ts"
import { linkEpoch } from "./link.ts"

export const loadUi = async () => {
  const [ui, servers] = await Promise.all([call("ui.get"), call("servers.list")])
  return { ui, servers }
}

/** A routine or workflow that its own page shows and focuses. */
export interface RevealTarget {
  readonly kind: "routine" | "workflow"
  readonly id: string
}

const createUiState = (initial: UiState, initialServers: readonly Server[]) => {
  const [ui, setUi] = createStore<UiState>(initial)
  // The linked servers come and go, and change state. A store keeps the rows (and their focus).
  const [servers, setServers] = createStore<Server[]>([...initialServers])
  const states = new Map<string, string | undefined>()
  for (const s of initialServers) states.set(s.id, s.state)
  const reloadServers = async () => {
    const next = await call("servers.list")
    // A server that came online again may have changed while it was away: open views read again.
    for (const s of next) {
      if (states.get(s.id) !== "online" && s.state === "online" && states.has(s.id)) {
        linkEpoch.bump()
      }
      // A server that removed this device: the open views drop what they hold of it.
      if (states.get(s.id) !== "not_allowed" && s.state === "not_allowed" && states.has(s.id)) {
        linkEpoch.bump()
      }
      states.set(s.id, s.state)
    }
    setServers(reconcile([...next], { key: "id" }))
  }
  onCleanup(window.robot.on("servers.changed", () => void reloadServers()))
  const [width, setWidth] = createSignal(window.innerWidth)
  const onResize = () => setWidth(window.innerWidth)
  window.addEventListener("resize", onResize)
  onCleanup(() => window.removeEventListener("resize", onResize))

  /** Updates the state at once and stores it. */
  const update = (patch: UiStatePatch) => {
    setUi(patch)
    void call("ui.update", patch)
  }

  const server = createMemo(() => servers.find((s) => s.id === ui.serverId) ?? servers[0])
  // Calls that a linked server answers go to that server (see `call`).
  createComputed(() => setActiveServer(server()?.id))
  const localServer = createMemo(() => servers.find((s) => s.kind === "local"))
  /** True for a computer that this one opens over the link, and is not online now. */
  const serverOffline = () => server()?.kind === "linked" && server()?.state !== "online"
  // A store updated by id, so rows keep their elements (and focus) when the list reloads.
  const [sectionStore, setSectionStore] = createStore<{ list: PlaceSection[] }>({ list: [] })
  const [fetched, { refetch: refetchPlaces }] = createResource(
    () => server()?.id,
    (serverId) => call("places.list", { serverId }).catch(() => []),
  )
  createEffect(() => {
    const next = fetched()
    if (next) setSectionStore("list", reconcile([...next], { key: "id" }))
  })
  const sections = () => sectionStore.list
  const offPlaces = window.robot.on("places.changed", ({ serverId }) => {
    if (serverId === server()?.id) void refetchPlaces()
  })
  onCleanup(offPlaces)

  const place = createMemo(() => {
    const id = server()?.id
    return id ? ui.places[id] : undefined
  })
  const narrow = () => width() < NARROW_WIDTH
  /** The kind whose list shows the box for the name of a new section, or undefined. */
  const [newSectionKind, setNewSectionKind] = createSignal<PlaceKind>()
  /** A call to the server for the sections. A failure only reloads the list: it was stale. */
  const sectionCall = async (run: () => Promise<unknown>) => {
    // The sections of a linked server are read only. These calls would change this computer.
    if (server()?.kind === "linked") return
    try {
      await run()
    } catch {
      void refetchPlaces()
    }
  }
  // Past its limits the list edge follows the pointer with growing resistance, then springs back.
  const [stretch, setStretch] = createSignal(0)
  const [snapping, setSnapping] = createSignal(false)
  /** The open settings section, or undefined when settings are closed. Not kept between runs. */
  const [settingsSection, setSettingsSection] = createSignal<string>()
  /** A routine or workflow that a checklist item asked to show. The page clears it when shown. */
  const [revealTarget, setRevealTarget] = createSignal<RevealTarget>()

  return {
    ui,
    servers,
    server,
    /** This computer, also when a linked server is open. Settings about this computer use it. */
    localServer,
    linked: () => server()?.kind === "linked",
    /**
     * True when the user can create and change agents and channels of the open server: always on
     * this computer, and on a linked server only while it is online and lets this device (012).
     */
    canChange: () => server()?.kind !== "linked" || server()?.canChange === true,
    serverOffline,
    sections,
    refetchPlaces,
    place,
    narrow,
    settingsSection,
    openSettings: (section = "general") => setSettingsSection(section),
    closeSettings: () => setSettingsSection(undefined),
    /** The panel shows when the user wants it and the window is wide enough. */
    activityPanelVisible: () => ui.activityPanel && !narrow(),
    selectServer: (serverId: string) => update({ serverId }),
    /** Opens a place. A notification names its server; without one, the server on screen. */
    selectPlace: (ref: PlaceRef, serverId?: string) => {
      const id = serverId ?? server()?.id
      if (id) update({ serverId: id, places: { ...ui.places, [id]: ref }, page: "chats" })
    },
    selectPage: (page: Page) => update({ page }),
    revealTarget,
    /** Opens the page of one routine or one workflow (spec 014). */
    reveal: (target: RevealTarget) => {
      setRevealTarget(target)
      update({ page: listPage(target.kind) })
    },
    clearReveal: () => setRevealTarget(undefined),
    toggleSection: (sectionId: string) =>
      update({
        collapsed: ui.collapsed.includes(sectionId)
          ? ui.collapsed.filter((s) => s !== sectionId)
          : [...ui.collapsed, sectionId],
      }),
    toggleActivityPanel: () => update({ activityPanel: !ui.activityPanel }),
    /** Picks the view of Agents. The view "By organization" has no new section, so its name box closes. */
    setAgentView: (agentView: AgentView) => {
      setNewSectionKind(undefined)
      update({ agentView })
    },
    /** Picks the view of the org chart: the canvas, or the list (spec 029). */
    setOrgView: (orgView: OrgView) => update({ orgView }),
    /** Picks the organization of the Today page, or null for "All" (spec 021). */
    setTodayOrg: (todayOrg: string | null) => update({ todayOrg }),
    newSectionKind,
    /** True when the section still exists in the list of its kind. */
    hasSection: (kind: PlaceKind, sectionId: string | null) =>
      sectionId !== null &&
      (sectionStore.list.find((s) => s.id === builtInSection(kind))?.sections ?? []).some(
        (s) => s.id === sectionId,
      ),
    /** Opens the name box of a new section in the list of a kind. It opens a closed list first. */
    startNewSection: (kind: PlaceKind) => {
      if (server()?.kind === "linked") return
      // The sections of the view "By organization" come from the organizations (spec 001).
      if (kind === "agent" && ui.agentView === "organization") return
      const builtIn = builtInSection(kind)
      if (ui.collapsed.includes(builtIn))
        update({ collapsed: ui.collapsed.filter((id) => id !== builtIn) })
      setNewSectionKind(kind)
    },
    cancelNewSection: () => setNewSectionKind(undefined),
    /** Makes a section. A refused name throws, so the name box can show why. */
    createSection: async (kind: PlaceKind, name: string) => {
      const serverId = server()?.id
      if (!serverId || server()?.kind === "linked") return
      await call("sections.create", { serverId, kind, name })
      setNewSectionKind(undefined)
    },
    /** A refused name throws, so the name box can show why. */
    renameSection: async (id: string, name: string) => {
      if (server()?.kind === "linked") return
      await call("sections.rename", { id, name })
    },
    moveSection: (id: string, direction: MoveDirection) =>
      sectionCall(() => call("sections.move", { id, direction })),
    deleteSection: (id: string) =>
      sectionCall(async () => {
        await call("sections.delete", { id })
        // The state of a section that is gone is not kept.
        if (ui.collapsed.includes(id)) update({ collapsed: ui.collapsed.filter((c) => c !== id) })
      }),
    /** Puts a place in a section of its kind, or in none (`null`). */
    movePlace: (ref: PlaceRef, sectionId: string | null) =>
      sectionCall(() => call("places.move", { ...ref, sectionId })),
    /** Pins a place to the group "Pinned", or unpins it. A refused pin throws. */
    pinPlace: (ref: PlaceRef, pinned: boolean) =>
      sectionCall(() => call("places.pin", { ...ref, pinned })),
    /** Sets the order of one list of places. */
    orderPlaces: (items: readonly PlaceRef[]) => sectionCall(() => call("places.order", { items })),
    /** Changes the width on screen only. Call `saveWidth` when the drag ends. */
    previewWidth: (placeListWidth: number) => setUi({ placeListWidth }),
    /** Extra width in px (negative or positive) while a drag is past a limit. Only on screen. */
    stretch,
    setStretch,
    /** True while the edge springs back after a drag past a limit. */
    snapping,
    setSnapping,
    saveWidth: () => update({ placeListWidth: ui.placeListWidth }),
    /** Changes the width of the workflow side column on screen only. Save it when the drag ends. */
    previewWorkflowSideWidth: (workflowSideWidth: number) => setUi({ workflowSideWidth }),
    saveWorkflowSideWidth: () => update({ workflowSideWidth: ui.workflowSideWidth }),
  }
}

export type UiController = ReturnType<typeof createUiState>

const UiContext = createContext<UiController>()

export const UiProvider = (props: ParentProps<{ ui: UiState; servers: readonly Server[] }>) => (
  <UiContext.Provider value={createUiState(props.ui, props.servers)}>
    {props.children}
  </UiContext.Provider>
)

export const useUi = () => {
  const state = useContext(UiContext)
  if (!state) throw new Error("useUi needs UiProvider")
  return state
}
