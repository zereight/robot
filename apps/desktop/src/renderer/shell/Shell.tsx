import {
  CLIENT_BLOCKED_PAGES,
  type MessageKey,
  type Page,
  type Place,
  type PlaceRef,
  type SectionId,
} from "@robot/shared"
import { PanelRight, PanelRightClose } from "lucide-solid"
import { createMemo, type JSX, Match, type ParentProps, Show, Switch, untrack } from "solid-js"
import { HelpPage } from "../pages/HelpPage.tsx"
import { SettingsPage, type SettingsSection } from "../settings/SettingsPage.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { IconButton } from "../ui/controls.tsx"
import { Presence, useClosing } from "../ui/Presence.tsx"
import { PlaceList } from "./PlaceList.tsx"
import { ServerNotice } from "./ServerNotice.tsx"
import { ServerRail } from "./ServerRail.tsx"
import styles from "./shell.module.css"

export interface PlaceView {
  readonly header: JSX.Element
  readonly body: JSX.Element
  readonly panel?: JSX.Element
}

export interface ShellProps {
  face?: (place: Place) => JSX.Element
  /** True when the place still exists. */
  placeExists?: (ref: PlaceRef) => boolean
  /** Draws an open place. Called once each time the open place changes. */
  renderPlace?: (ref: PlaceRef) => PlaceView | undefined
  /** A button at the end of a place list section header. */
  sectionAction?: (section: SectionId) => JSX.Element
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

const ActivityPanel = (props: ParentProps) => {
  const { t } = useApp()
  const closing = useClosing()
  return (
    <aside
      class={styles.panel}
      aria-label={t("panel.title")}
      data-closing={closing()}
      data-testid="activity-panel"
    >
      <div class={styles.panelInner}>
        <div class={styles.panelHeader}>{t("panel.title")}</div>
        {props.children ?? <div class={styles.panelBody}>{t("panel.empty")}</div>}
      </div>
    </aside>
  )
}

export const Shell = (props: ShellProps) => {
  const { t } = useApp()
  const ui = useUi()

  // A string key, so the view is made again only when another place opens or this one goes.
  const openKey = createMemo(() => {
    const ref = ui.place()
    return ref && props.placeExists?.(ref) ? `${ref.kind}:${ref.id}` : undefined
  })
  const view = createMemo(() => {
    const key = openKey()
    if (!key) return undefined
    const [kind, id] = key.split(":") as [PlaceRef["kind"], string]
    return untrack(() => props.renderPlace?.({ kind, id }))
  })

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
      data-snapping={ui.snapping()}
      style={{ "--list-width": `${ui.ui.placeListWidth + ui.stretch()}px` }}
      data-testid="app-root"
    >
      <ServerRail onOpenSettings={() => ui.openSettings()} />
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
        <PlaceList
          {...(props.face ? { face: props.face } : {})}
          {...(props.sectionAction ? { sectionAction: props.sectionAction } : {})}
        />
        <main class={styles.main} data-testid="conversation">
          <ServerNotice />
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
                  keyed
                  fallback={
                    <Empty
                      title={t("main.noPlace.title")}
                      body={t("main.noPlace.body")}
                      testId="no-place"
                    />
                  }
                >
                  {(v) => v.body}
                </Show>
              </div>
            </Match>
            <Match when={ui.ui.page === "help"}>
              <header class={styles.header}>
                <span class={styles.headerTitle}>{pageTitle("help")}</span>
              </header>
              <HelpPage />
            </Match>
            <Match
              when={ui.linked() && (CLIENT_BLOCKED_PAGES as readonly Page[]).includes(ui.ui.page)}
            >
              <header class={styles.header}>
                <span class={styles.headerTitle}>{pageTitle(ui.ui.page)}</span>
              </header>
              <p class={styles.pageNotice} data-testid="page-open-on-server">
                {t("link.openOnServer", { name: ui.server()?.name ?? "" })}
              </p>
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
        <Presence when={ui.ui.page === "chats" && ui.activityPanelVisible()} exit="medium">
          {() => <ActivityPanel>{view()?.panel}</ActivityPanel>}
        </Presence>
      </Show>
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
