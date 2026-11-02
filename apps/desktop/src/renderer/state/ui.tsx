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
  /** The open settings section, or undefined when settings are closed. Not kept between runs. */
  const [settingsSection, setSettingsSection] = createSignal<string>()

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
