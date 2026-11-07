import {
  clampPanelWidth,
  LIST_DOCK_MIN,
  NARROW_WIDTH,
  type Page,
  type PlaceRef,
  type Server,
  type UiState,
  type UiStatePatch,
} from "@robot/shared"
import {
  createContext,
  createMemo,
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

const createUiState = (initial: UiState, initialServers: readonly Server[]) => {
  const [ui, setUi] = createStore<UiState>({ ...initial })
  const [servers, setServers] = createStore<Server[]>([...initialServers])
  const reloadServers = async () => {
    setServers(reconcile([...(await call("servers.list"))], { key: "id" }))
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
  /** The open workflow of the open server. */
  const place = createMemo(() => {
    const id = server()?.id
    return id ? ui.places[id] : undefined
  })
  /** The open settings section, or undefined when settings are closed. Not kept between runs. */
  const [settingsSection, setSettingsSection] = createSignal<string>()

  return {
    ui,
    servers,
    server,
    localServer: createMemo(() => servers.find((s) => s.kind === "local")),
    place,
    narrow: () => width() < NARROW_WIDTH,
    settingsSection,
    openSettings: (section = "general") => setSettingsSection(section),
    closeSettings: () => setSettingsSection(undefined),
    selectServer: (serverId: string) => update({ serverId }),
    /** Opens a workflow. */
    selectPlace: (ref: PlaceRef) => {
      const id = server()?.id
      if (id) update({ places: { ...ui.places, [id]: ref }, page: "workflows" })
    },
    /** Closes the open workflow and shows the list. */
    closePlace: () => {
      const id = server()?.id
      if (!id) return
      const { [id]: _gone, ...rest } = ui.places
      update({ places: rest })
    },
    /**
     * A page button. The Tasks button opens the tab "Tasks", also when the tab "Events" was the
     * last one; the last tab is what a restart restores (spec 001, 005, 038).
     */
    selectPage: (page: Page) => update(page === "tasks" ? { page, tasksTab: "tasks" } : { page }),
    /** The workflow list docks beside the centre column (spec 001). Else it is an overlay. */
    listDocked: () => width() >= LIST_DOCK_MIN,
    /** The panel column of the studio is open (spec 001). */
    panelOpen: () => ui.activityPanel,
    selectPanelOpen: (open: boolean) => update({ activityPanel: open }),
    /** The run strip is folded to its tab row (spec 001). */
    stripFolded: () => ui.stripFolded,
    selectStripFolded: (stripFolded: boolean) => update({ stripFolded }),
    selectPanelWidth: (panelWidth: number) => update({ panelWidth: clampPanelWidth(panelWidth) }),
    /** The tab of the Tasks page; it stays after a restart (spec 005, 038). */
    selectTasksTab: (tasksTab: UiState["tasksTab"]) => update({ tasksTab }),
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
