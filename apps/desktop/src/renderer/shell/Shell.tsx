import type { Page } from "@robot/shared"
import { Match, Show, Switch } from "solid-js"
import { HelpPage } from "../pages/HelpPage.tsx"
import { SettingsPage, type SettingsSection } from "../settings/SettingsPage.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { TasksPage } from "../tasks/TasksPage.tsx"
import { Presence } from "../ui/Presence.tsx"
import { WorkflowsPage } from "../workflows/WorkflowsPage.tsx"
import { ServerRail } from "./ServerRail.tsx"
import styles from "./shell.module.css"

export interface ShellProps {
  settingsSections?: Partial<Record<SettingsSection, () => import("solid-js").JSX.Element>>
}

export const Shell = (props: ShellProps) => {
  const { t } = useApp()
  const ui = useUi()
  const pageTitle = (page: Page) => (page === "help" ? t("page.help") : t("page.workflows"))

  return (
    <div class={styles.shell} data-narrow={ui.narrow()} data-testid="app-root">
      <ServerRail onOpenSettings={() => ui.openSettings()} />
      <main class={styles.main} data-testid="conversation">
        <Show
          when={ui.server()}
          fallback={
            <div class={styles.empty} data-testid="no-server">
              <h2>{t("main.noServer.title")}</h2>
              <p>{t("main.noServer.body")}</p>
            </div>
          }
        >
          <Switch>
            <Match when={ui.ui.page === "help"}>
              <header class={styles.header}>
                <span class={styles.headerTitle}>{pageTitle("help")}</span>
              </header>
              <HelpPage />
            </Match>
            <Match when={ui.ui.page === "tasks"}>
              <TasksPage />
            </Match>
            <Match when={true}>
              <WorkflowsPage />
            </Match>
          </Switch>
        </Show>
      </main>
      <Presence when={ui.settingsSection()}>
        {(section) => (
          <SettingsPage
            initial={section as SettingsSection}
            onClose={ui.closeSettings}
            {...(props.settingsSections ? { extra: props.settingsSections } : {})}
          />
        )}
      </Presence>
    </div>
  )
}
