import { Show } from "solid-js"
import { SettingsPage, type SettingsSection } from "../settings/SettingsPage.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Presence } from "../ui/Presence.tsx"
import { ServerRail } from "./ServerRail.tsx"
import { Studio } from "./Studio.tsx"
import styles from "./shell.module.css"

export interface ShellProps {
  settingsSections?: Partial<Record<SettingsSection, () => import("solid-js").JSX.Element>>
}

export const Shell = (props: ShellProps) => {
  const { t } = useApp()
  const ui = useUi()

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
          <Studio />
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
