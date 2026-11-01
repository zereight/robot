import {
  NARROW_WIDTH,
  type Page,
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
    /** Changes the width on screen only. Call `saveWidth` when the drag ends. */
    previewWidth: (placeListWidth: number) => setUi({ placeListWidth }),
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
