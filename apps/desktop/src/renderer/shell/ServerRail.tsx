import type { Page } from "@robot/shared"
import {
  ChartColumn,
  CircleHelp,
  ListChecks,
  MessagesSquare,
  Plus,
  Settings,
  Workflow,
} from "lucide-solid"
import { createSignal, For, type JSX, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./shell.module.css"

const initials = (name: string) => name.trim().slice(0, 1).toUpperCase() || "?"

export const ServerRail = (props: { onOpenSettings: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [addOpen, setAddOpen] = createSignal(false)

  const PageButton = (p: { page: Page; label: string; icon: JSX.Element }) => (
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
    </button>
  )

  return (
    <nav class={styles.rail} aria-label={t("rail.label")} data-testid="rail">
      <div class={styles.railGroup}>
        <For each={ui.servers}>
          {(server) => (
            <div class={styles.tileWrap} data-selected={ui.server()?.id === server.id}>
              <button
                type="button"
                class={styles.tile}
                aria-label={server.name}
                aria-pressed={ui.server()?.id === server.id}
                title={server.name}
                data-testid="server-tile"
                onClick={() => ui.selectServer(server.id)}
              >
                {initials(server.name)}
              </button>
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
          <PageButton page="workflows" label={t("page.workflows")} icon={<Workflow size={20} />} />
          <PageButton page="tasks" label={t("page.tasks")} icon={<ListChecks size={20} />} />
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
      <Show when={addOpen()}>
        <Dialog
          label={t("rail.addServer")}
          onClose={() => setAddOpen(false)}
          testId="add-server-dialog"
        >
          <p>{t("rail.addServer.later")}</p>
          <div class={styles.dialogActions}>
            <Button variant="primary" onClick={() => setAddOpen(false)}>
              {t("rail.ok")}
            </Button>
          </div>
        </Dialog>
      </Show>
    </nav>
  )
}
