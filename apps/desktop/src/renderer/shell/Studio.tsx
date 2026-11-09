import { PanelLeft } from "lucide-solid"
import {
  createEffect,
  createResource,
  createSignal,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { ChatPanel } from "../chat/ChatPanel.tsx"
import { call } from "../lib/rpc.ts"
import { HelpPage } from "../pages/HelpPage.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { TasksPage } from "../tasks/TasksPage.tsx"
import { IconButton } from "../ui/controls.tsx"
import { createRunsState } from "../workflows/runsState.ts"
import { WorkflowList } from "../workflows/WorkflowList.tsx"
import { WorkflowView } from "../workflows/WorkflowView.tsx"
import styles from "./shell.module.css"

/**
 * The studio (spec 001): the workflow list, the centre column and the panel column in one
 * view. In a narrow window the list and the panel close, and each opens as an overlay.
 */
export const Studio = () => {
  const { t } = useApp()
  const ui = useUi()
  const [ids, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId): Promise<readonly string[]> =>
      call("workflows.list", { serverId })
        .then((list) => list.map((w) => w.id))
        .catch(() => []),
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  const open = () => {
    const ref = ui.place()
    return ref && ids()?.includes(ref.id) ? ref.id : undefined
  }
  const runs = createRunsState(() => open() ?? "")
  // Overlays. They start closed (spec 001, "States"). The list overlays below the dock
  // width, the chat only in a narrow window.
  const [listOverlay, setListOverlay] = createSignal(false)
  const [chatOverlay, setChatOverlay] = createSignal(false)
  const listOpen = () => !ui.listDocked() && listOverlay()
  const chatOpen = () => ui.narrow() && chatOverlay()
  // Picking a workflow or a page closes the list overlay. A refresh of the list does not: it is
  // not a pick.
  createEffect(
    on(
      () => [ui.place(), ui.ui.page] as const,
      () => setListOverlay(false),
      { defer: true },
    ),
  )
  // Escape closes an overlay.
  createEffect(() => {
    if (!(listOpen() || chatOpen())) return
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setListOverlay(false)
        setChatOverlay(false)
      }
    }
    window.addEventListener("keydown", close)
    onCleanup(() => window.removeEventListener("keydown", close))
  })
  /** The width of the panel column while the user drags its edge. */
  const [dragWidth, setDragWidth] = createSignal<number>()
  const panelWidth = () => dragWidth() ?? ui.ui.panelWidth
  const startDrag = (startX: number) => {
    const from = ui.ui.panelWidth
    setDragWidth(from)
    const move = (e: MouseEvent) => setDragWidth(from + (startX - e.clientX))
    const end = () => {
      window.removeEventListener("mousemove", move)
      window.removeEventListener("mouseup", end)
      const width = dragWidth()
      setDragWidth(undefined)
      if (width !== undefined) ui.selectPanelWidth(width)
    }
    window.addEventListener("mousemove", move)
    window.addEventListener("mouseup", end)
  }
  const panelDocked = () => !ui.narrow() && ui.panelOpen()
  return (
    <div
      class={styles.studio}
      data-list={ui.listDocked() ? "docked" : "overlay"}
      data-panel={panelDocked() ? "open" : "closed"}
      data-testid="studio"
    >
      <Show when={ui.listDocked() || listOpen()}>
        <aside
          class={styles.studioList}
          data-overlay={!ui.listDocked()}
          data-testid="studio-list"
          aria-label={t("page.workflows")}
        >
          <WorkflowList />
        </aside>
      </Show>
      <div class={styles.studioCentre} data-testid="studio-centre">
        <Switch>
          <Match when={ui.ui.page === "help"}>
            <header class={styles.header}>
              <span class={styles.headerTitle}>{t("page.help")}</span>
            </header>
            <HelpPage />
          </Match>
          <Match when={ui.ui.page === "tasks"}>
            <TasksPage />
          </Match>
          <Match when={open()} keyed>
            {(id) => (
              <WorkflowView
                id={id}
                runs={runs}
                onShowList={() => setListOverlay(true)}
                onShowChat={() => setChatOverlay(true)}
              />
            )}
          </Match>
          <Match when={true}>
            <Show when={!ui.listDocked()}>
              <header class={styles.header} data-testid="studio-pick-header">
                <IconButton
                  label={t("studio.list.show")}
                  onClick={() => setListOverlay(true)}
                  data-testid="studio-show-list"
                >
                  <PanelLeft size={18} />
                </IconButton>
              </header>
            </Show>
            <div class={styles.empty} data-testid="studio-pick">
              <p>{t("studio.pick")}</p>
            </div>
          </Match>
        </Switch>
      </div>
      <Show when={panelDocked() || chatOpen()}>
        <aside
          class={styles.studioPanel}
          data-overlay={ui.narrow()}
          data-testid="studio-panel"
          aria-label={t("chat.title")}
          style={ui.narrow() ? {} : { width: `${panelWidth()}px` }}
        >
          <Show when={!ui.narrow()}>
            <hr
              class={styles.studioHandle}
              data-testid="studio-panel-handle"
              aria-orientation="vertical"
              aria-label={t("studio.panel.resize")}
              onMouseDown={(e) => {
                e.preventDefault()
                startDrag(e.clientX)
              }}
            />
          </Show>
          <Show
            when={open()}
            keyed
            fallback={
              <div class={styles.empty} data-testid="studio-chat-empty">
                <p>{t("studio.chat.empty")}</p>
              </div>
            }
          >
            {(id) => <ChatPanel workflowId={id} running={runs.working()} />}
          </Show>
        </aside>
      </Show>
      <Show when={listOpen() || chatOpen()}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a click outside closes the overlay; Escape is the keyboard way */}
        <div
          class={styles.studioBackdrop}
          data-testid="studio-backdrop"
          onClick={() => {
            setListOverlay(false)
            setChatOverlay(false)
          }}
        />
      </Show>
    </div>
  )
}
