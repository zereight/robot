import type { Page } from "@robot/shared"
import { CircleHelp, ListChecks, Settings } from "lucide-solid"
import { For, type JSX } from "solid-js"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import styles from "./shell.module.css"

const initials = (name: string) => name.trim().slice(0, 1).toUpperCase() || "?"

export const ServerRail = (props: { onOpenSettings: () => void }) => {
  const { t } = useApp()
  const ui = useUi()

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
            <div
              class={styles.tileWrap}
              data-selected={ui.server()?.id === server.id}
              data-kind={server.kind}
            >
              <button
                type="button"
                class={styles.tile}
                aria-label={server.name}
                aria-pressed={ui.server()?.id === server.id}
                title={server.name}
                data-testid="server-tile"
                data-name={server.name}
                onClick={() => ui.selectServer(server.id)}
              >
                {initials(server.name)}
              </button>
            </div>
          )}
        </For>
      </div>
      <div class={styles.railDivider} />
      <div class={styles.railGroup}>
        <PageButton page="tasks" label={t("page.tasks")} icon={<ListChecks size={20} />} />
      </div>
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
    </nav>
  )
}
