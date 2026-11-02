import {
  builtInSection,
  type MoveDirection,
  NARROW_WIDTH,
  type Page,
  type PlaceKind,
  type PlaceRef,
  type PlaceSection,
  type Server,
  type UiState,
  type UiStatePatch,
} from "@robot/shared"
import {
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
import { call } from "../lib/rpc.ts"

export const loadUi = async () => {
  const [ui, servers] = await Promise.all([call("ui.get"), call("servers.list")])
  return { ui, servers }
}

const createUiState = (initial: UiState, servers: readonly Server[]) => {
  const [ui, setUi] = createStore<UiState>(initial)
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
  // A store updated by id, so rows keep their elements (and focus) when the list reloads.
  const [sectionStore, setSectionStore] = createStore<{ list: PlaceSection[] }>({ list: [] })
  const [fetched, { refetch: refetchPlaces }] = createResource(
    () => server()?.id,
    (serverId) => call("places.list", { serverId }),
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

  return {
    ui,
    servers,
    server,
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
    selectPlace: (ref: PlaceRef) => {
      const id = server()?.id
      if (id) update({ places: { ...ui.places, [id]: ref }, page: "chats" })
    },
    selectPage: (page: Page) => update({ page }),
    toggleSection: (sectionId: string) =>
      update({
        collapsed: ui.collapsed.includes(sectionId)
          ? ui.collapsed.filter((s) => s !== sectionId)
          : [...ui.collapsed, sectionId],
      }),
    toggleActivityPanel: () => update({ activityPanel: !ui.activityPanel }),
    newSectionKind,
    /** Opens the name box of a new section in the list of a kind. It opens a closed list first. */
    startNewSection: (kind: PlaceKind) => {
      const builtIn = builtInSection(kind)
      if (ui.collapsed.includes(builtIn))
        update({ collapsed: ui.collapsed.filter((id) => id !== builtIn) })
      setNewSectionKind(kind)
    },
    cancelNewSection: () => setNewSectionKind(undefined),
    /** Makes a section. A refused name throws, so the name box can show why. */
    createSection: async (kind: PlaceKind, name: string) => {
      const serverId = server()?.id
      if (!serverId) return
      await call("sections.create", { serverId, kind, name })
      setNewSectionKind(undefined)
    },
    /** A refused name throws, so the name box can show why. */
    renameSection: async (id: string, name: string) => {
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
    /** Changes the width on screen only. Call `saveWidth` when the drag ends. */
    previewWidth: (placeListWidth: number) => setUi({ placeListWidth }),
    /** Extra width in px (negative or positive) while a drag is past a limit. Only on screen. */
    stretch,
    setStretch,
    /** True while the edge springs back after a drag past a limit. */
    snapping,
    setSnapping,
    saveWidth: () => update({ placeListWidth: ui.placeListWidth }),
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
