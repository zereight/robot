import type { MessageKey, Page, Place, PlaceRef } from "@robot/shared"
import { PanelRight, PanelRightClose } from "lucide-solid"
import { createSignal, type JSX, Match, Show, Switch } from "solid-js"
import { HelpPage } from "../pages/HelpPage.tsx"
import { SettingsPage, type SettingsSection } from "../settings/SettingsPage.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { IconButton } from "../ui/controls.tsx"
import { PlaceList } from "./PlaceList.tsx"
import { ServerRail } from "./ServerRail.tsx"
import styles from "./shell.module.css"

export interface PlaceView {
  readonly header: JSX.Element
  readonly body: JSX.Element
  readonly panel?: JSX.Element
}

export interface ShellProps {
  face?: (place: Place) => JSX.Element
  /** Draws an open place. Returns nothing when the place does not exist. */
  renderPlace?: (ref: PlaceRef) => PlaceView | undefined
  /** Draws pages that later features own. */
  pages?: Partial<Record<Page, () => JSX.Element>>
  settingsSections?: Partial<Record<SettingsSection, () => JSX.Element>>
}

const Empty = (props: { title: string; body: string; testId: string }) => (
  <div class={styles.empty} data-testid={props.testId}>
    <h2>{props.title}</h2>
    <p>{props.body}</p>
  </div>
)

export const Shell = (props: ShellProps) => {
  const { t } = useApp()
  const ui = useUi()
  const [settingsOpen, setSettingsOpen] = createSignal(false)

  const view = () => {
    const ref = ui.place()
    return ref ? props.renderPlace?.(ref) : undefined
  }

  const PanelToggle = () => (
    <Show when={!ui.narrow()}>
      <IconButton
        label={ui.ui.activityPanel ? t("panel.hide") : t("panel.show")}
        aria-pressed={ui.ui.activityPanel}
        onClick={ui.toggleActivityPanel}
        data-testid="toggle-activity-panel"
      >
        {ui.ui.activityPanel ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
      </IconButton>
    </Show>
  )

  const pageTitle = (page: Page) => t(`page.${page}` as MessageKey)

  return (
    <div
      class={styles.shell}
      data-narrow={ui.narrow()}
      style={{ "--list-width": `${ui.ui.placeListWidth}px` }}
      data-testid="app-root"
    >
      <ServerRail onOpenSettings={() => setSettingsOpen(true)} />
      <Show
        when={ui.server()}
        fallback={
          <main class={styles.main} style={{ "grid-column": "2 / -1" }}>
            <Empty
              title={t("main.noServer.title")}
              body={t("main.noServer.body")}
              testId="no-server"
            />
          </main>
        }
      >
        <PlaceList {...(props.face ? { face: props.face } : {})} />
        <main class={styles.main} data-testid="conversation">
          <Switch>
            <Match when={ui.ui.page === "chats"}>
              <header class={styles.header} data-testid="conversation-header">
                {view()?.header}
                <span class={styles.headerSpacer} />
                <PanelToggle />
              </header>
              <div class={styles.body}>
                <Show
                  when={view()}
                  fallback={
                    <Empty
                      title={t("main.noPlace.title")}
                      body={t("main.noPlace.body")}
                      testId="no-place"
                    />
                  }
                >
                  {(v) => v().body}
                </Show>
              </div>
            </Match>
            <Match when={ui.ui.page === "help"}>
              <header class={styles.header}>
                <span class={styles.headerTitle}>{pageTitle("help")}</span>
              </header>
              <HelpPage />
            </Match>
            <Match when={true}>
              <header class={styles.header}>
                <span class={styles.headerTitle}>{pageTitle(ui.ui.page)}</span>
              </header>
              {props.pages?.[ui.ui.page]?.() ?? (
                <div class={styles.page} data-testid="page-later">
                  <p>{t("page.later")}</p>
                </div>
              )}
            </Match>
          </Switch>
        </main>
        <Show when={ui.ui.page === "chats" && ui.activityPanelVisible()}>
          <aside class={styles.panel} aria-label={t("panel.title")} data-testid="activity-panel">
            <div class={styles.panelHeader}>{t("panel.title")}</div>
            {view()?.panel ?? <div class={styles.panelBody}>{t("panel.empty")}</div>}
          </aside>
        </Show>
      </Show>
      <Show when={settingsOpen()}>
        <SettingsPage
          onClose={() => setSettingsOpen(false)}
          {...(props.settingsSections ? { extra: props.settingsSections } : {})}
        />
      </Show>
    </div>
  )
}
