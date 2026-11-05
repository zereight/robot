import type { MessageKey, Page, Server } from "@robot/shared"
import {
  CalendarCheck,
  ChartColumn,
  CircleHelp,
  ListChecks,
  LoaderCircle,
  MessagesSquare,
  Network,
  Plus,
  Repeat,
  Settings,
  TriangleAlert,
  WifiOff,
  Workflow,
} from "lucide-solid"
import { createSignal, For, type JSX, Show } from "solid-js"
import { ConnectDialog } from "../devices/ConnectDialog.tsx"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useToday } from "../state/today.tsx"
import { useUi } from "../state/ui.tsx"
import { ContextMenu } from "../ui/ContextMenu.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./shell.module.css"

const initials = (name: string) => name.trim().slice(0, 1).toUpperCase() || "?"

export const ServerRail = (props: { onOpenSettings: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const today = useToday()
  const [addOpen, setAddOpen] = createSignal(false)
  const [menu, setMenu] = createSignal<{ server: Server; x: number; y: number }>()

  /** The state of a linked server as one word, for the label of its tile. */
  const stateWord = (server: Server) =>
    server.kind === "linked" && server.state ? t(`devices.state.${server.state}` as MessageKey) : ""

  const PageButton = (p: {
    page: Page
    label: string
    icon: JSX.Element
    badge?: string | null
  }) => (
    <button
      type="button"
      class={styles.pageButton}
      aria-label={p.label}
      title={p.label}
      aria-current={ui.ui.page === p.page ? "page" : undefined}
      data-testid={`page-${p.page}`}
      onClick={() => ui.selectPage(p.page)}
    >
      {p.icon}
      <Show when={p.badge}>
        {(text) => (
          <span class={styles.pageBadge} data-testid={`page-${p.page}-badge`}>
            {text()}
          </span>
        )}
      </Show>
    </button>
  )

  return (
    <nav class={styles.rail} aria-label={t("rail.label")} data-testid="rail">
      <div class={styles.railGroup}>
        <For each={ui.servers}>
          {(server) => (
            <div
              class={styles.tileWrap}
              data-selected={ui.server()?.id === server.id}
              data-kind={server.kind}
              data-state={server.state}
            >
              <button
                type="button"
                class={styles.tile}
                aria-label={
                  server.kind === "linked"
                    ? t("link.tile.label", { name: server.name, state: stateWord(server) })
                    : server.name
                }
                aria-pressed={ui.server()?.id === server.id}
                title={
                  server.kind === "linked"
                    ? t("link.tile.label", { name: server.name, state: stateWord(server) })
                    : server.name
                }
                data-testid="server-tile"
                data-name={server.name}
                data-state={server.state}
                onClick={() => ui.selectServer(server.id)}
                onContextMenu={(e) => {
                  if (server.kind !== "linked") return
                  e.preventDefault()
                  setMenu({ server, x: e.clientX, y: e.clientY })
                }}
              >
                {initials(server.name)}
              </button>
              <Show when={server.kind === "linked" && server.state && server.state !== "online"}>
                <span class={styles.tileMark} data-mark={server.state} aria-hidden="true">
                  {server.state === "connecting" || server.state === "reconnecting" ? (
                    <LoaderCircle size={10} class={styles.spin ?? ""} />
                  ) : server.state === "offline" ? (
                    <WifiOff size={10} />
                  ) : (
                    <TriangleAlert size={10} />
                  )}
                </span>
              </Show>
            </div>
          )}
        </For>
        <div class={styles.tileWrap}>
          <button
            type="button"
            class={styles.tile}
            aria-label={t("rail.addServer")}
            title={t("rail.addServer")}
            data-testid="server-add"
            onClick={() => setAddOpen(true)}
          >
            <Plus size={20} />
          </button>
        </div>
      </div>
      <Show when={ui.servers.length > 0}>
        <div class={styles.railDivider} />
        <div class={styles.railGroup}>
          <PageButton page="chats" label={t("page.chats")} icon={<MessagesSquare size={20} />} />
          <PageButton
            page="today"
            label={
              today.badgeText()
                ? t("today.badge.label", { count: today.badgeText() ?? "" })
                : t("page.today")
            }
            icon={<CalendarCheck size={20} />}
            badge={today.badgeText()}
          />
          <PageButton page="workflows" label={t("page.workflows")} icon={<Workflow size={20} />} />
          <PageButton page="routines" label={t("page.routines")} icon={<Repeat size={20} />} />
          <PageButton page="tasks" label={t("page.tasks")} icon={<ListChecks size={20} />} />
          <PageButton page="orgchart" label={t("page.orgchart")} icon={<Network size={20} />} />
          <PageButton page="usage" label={t("page.usage")} icon={<ChartColumn size={20} />} />
        </div>
      </Show>
      <div class={styles.railSpacer} />
      <div class={styles.railGroup}>
        <PageButton page="help" label={t("page.help")} icon={<CircleHelp size={20} />} />
        <button
          type="button"
          class={styles.pageButton}
          aria-label={t("page.settings")}
          title={t("page.settings")}
          data-testid="open-settings"
          onClick={props.onOpenSettings}
        >
          <Settings size={20} />
        </button>
      </div>
      <Presence when={addOpen()}>
        {() => <ConnectDialog onClose={() => setAddOpen(false)} />}
      </Presence>
      <Show when={menu()}>
        {(open) => {
          // Read once: the menu closes before its item runs, and `open` is empty then.
          const { server, x, y } = open()
          return (
            <ContextMenu
              x={x}
              y={y}
              label={t("link.tile.menu", { name: server.name })}
              items={[
                {
                  label: t("link.tile.remove", { name: server.name }),
                  testId: "server-tile-remove",
                  run: () => {
                    if (server.linkId) void call("devices.server.remove", { id: server.linkId })
                  },
                },
              ]}
              onClose={() => setMenu(undefined)}
            />
          )
        }}
      </Show>
    </nav>
  )
}
