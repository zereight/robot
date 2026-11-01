import type { LicenseEntry, MessageKey, MessageParams } from "@robot/shared"
import { X } from "lucide-solid"
import {
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  Switch as SwitchCase,
} from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, IconButton, Segmented, Switch } from "../ui/controls.tsx"
import { useClosing } from "../ui/Presence.tsx"
import styles from "./settings.module.css"

export const sections = [
  "general",
  "appearance",
  "providers",
  "devices",
  "notifications",
  "archive",
  "data",
  "about",
] as const
export type SettingsSection = (typeof sections)[number]

const Row = (props: ParentProps<{ label: string; hint?: string | undefined; testId?: string }>) => (
  <div class={styles.row} data-testid={props.testId}>
    <div>
      <div class={styles.label}>{props.label}</div>
      <Show when={props.hint}>
        <div class={styles.hint}>{props.hint}</div>
      </Show>
    </div>
    {props.children}
  </div>
)

const General = () => {
  const app = useApp()
  const { t } = app
  return (
    <>
      <Row label={t("settings.language")}>
        <Segmented
          label={t("settings.language")}
          testId="setting-language"
          value={app.settings.language}
          onChange={(language) => app.update({ language })}
          options={[
            { value: "system", label: t("settings.language.system") },
            { value: "en", label: t("settings.language.en") },
            { value: "ko", label: t("settings.language.ko") },
          ]}
        />
      </Row>
      <Row label={t("settings.startAtLogin")} hint={t("settings.startAtLogin.hint")}>
        <Switch
          label={t("settings.startAtLogin")}
          testId="setting-start-at-login"
          checked={app.settings.startAtLogin}
          onChange={(startAtLogin) => app.update({ startAtLogin })}
        />
      </Row>
      <Row
        label={t("settings.workspaceRoot")}
        hint={app.settings.workspaceRoot || app.info.defaultWorkspaceRoot}
        testId="setting-workspace-root"
      >
        <div class={styles.actions}>
          <Show when={app.settings.workspaceRoot}>
            <Button onClick={() => app.update({ workspaceRoot: "" })}>
              {t("settings.workspaceRoot.reset")}
            </Button>
          </Show>
          <Button onClick={() => call("settings.pickWorkspaceRoot")}>
            {t("settings.workspaceRoot.change")}
          </Button>
        </div>
      </Row>
    </>
  )
}

const Appearance = () => {
  const app = useApp()
  const { t } = app
  return (
    <>
      <Row label={t("settings.theme")}>
        <Segmented
          label={t("settings.theme")}
          testId="setting-theme"
          value={app.settings.theme}
          onChange={(theme) => app.update({ theme })}
          options={[
            { value: "system", label: t("settings.theme.system") },
            { value: "dark", label: t("settings.theme.dark") },
            { value: "light", label: t("settings.theme.light") },
          ]}
        />
      </Row>
      <Row label={t("settings.textSize")}>
        <Segmented
          label={t("settings.textSize")}
          testId="setting-text-size"
          value={app.settings.textSize}
          onChange={(textSize) => app.update({ textSize })}
          options={[
            { value: "small", label: t("settings.textSize.small") },
            { value: "default", label: t("settings.textSize.default") },
            { value: "large", label: t("settings.textSize.large") },
          ]}
        />
      </Row>
      <Row label={t("settings.compactPlaces")} hint={t("settings.compactPlaces.hint")}>
        <Switch
          label={t("settings.compactPlaces")}
          testId="setting-compact-places"
          checked={app.settings.compactPlaces}
          onChange={(compactPlaces) => app.update({ compactPlaces })}
        />
      </Row>
      <Row label={t("settings.reduceMotion")}>
        <Segmented
          label={t("settings.reduceMotion")}
          testId="setting-reduce-motion"
          value={app.settings.reduceMotion}
          onChange={(reduceMotion) => app.update({ reduceMotion })}
          options={[
            { value: "system", label: t("settings.reduceMotion.system") },
            { value: "on", label: t("settings.reduceMotion.on") },
            { value: "off", label: t("settings.reduceMotion.off") },
          ]}
        />
      </Row>
    </>
  )
}

const Data = () => {
  const app = useApp()
  const { t } = app
  const [note, setNote] = createSignal<{ key: MessageKey; params?: MessageParams }>()
  const [failed, setFailed] = createSignal(false)
  const run = async (
    action: () => Promise<{ key: MessageKey; params?: MessageParams } | undefined>,
  ) => {
    setNote(undefined)
    setFailed(false)
    try {
      setNote(await action())
    } catch (e) {
      setFailed(true)
      setNote(describeError(e))
    }
  }
  return (
    <>
      <Row label={t("settings.data.folder")} hint={app.info.dataDir} testId="setting-data-folder">
        <Button onClick={() => call("data.openFolder")}>{t("settings.data.open")}</Button>
      </Row>
      <Row
        label={t("settings.data.export")}
        hint={t("settings.data.export.hint")}
        testId="setting-export"
      >
        <Button
          data-testid="data-export"
          onClick={() =>
            run(async () => {
              const result = await call("data.export")
              return result.path
                ? { key: "settings.data.exported", params: { path: result.path } }
                : undefined
            })
          }
        >
          {t("settings.data.export.button")}
        </Button>
      </Row>
      <Row
        label={t("settings.data.restore")}
        hint={t("settings.data.restore.hint")}
        testId="setting-restore"
      >
        <Button
          data-testid="data-restore"
          onClick={() =>
            run(async () => {
              const result = await call("data.restore")
              return result ? { key: "settings.data.restoreed", params: result } : undefined
            })
          }
        >
          {t("settings.data.restore.button")}
        </Button>
      </Row>
      <Show when={note()}>
        {(n) => (
          <p
            class={styles.hint}
            role={failed() ? "alert" : "status"}
            data-testid={failed() ? "data-error" : "data-note"}
          >
            {t(n().key, n().params)}
          </p>
        )}
      </Show>
    </>
  )
}

const About = () => {
  const app = useApp()
  const { t } = app
  const [licenses] = createResource<readonly LicenseEntry[]>(() => call("app.licenses"))
  return (
    <>
      <Row
        label={t("app.name")}
        hint={t("settings.about.version", { version: app.info.version })}
        testId="setting-version"
      />
      <div class={styles.row} style={{ display: "block" }}>
        <div class={styles.label}>{t("settings.about.licenses")}</div>
        <div class={styles.hint}>
          {t("settings.about.licenses.count", { count: licenses()?.length ?? 0 })}
        </div>
        <ul class={styles.licenses} data-testid="licenses">
          <For each={licenses()}>
            {(entry) => (
              <li>
                <span>
                  {entry.name} {entry.version}
                </span>
                <span>{entry.license}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </>
  )
}

const Later = () => <p class={styles.muted}>{useApp().t("settings.later")}</p>

export const SettingsPage = (props: {
  initial?: SettingsSection
  onClose: () => void
  /** Extra section bodies supplied by later features. */
  extra?: Partial<Record<SettingsSection, () => JSX.Element>>
}) => {
  const closing = useClosing()
  const app = useApp()
  const { t } = app
  const [section, setSection] = createSignal<SettingsSection>(props.initial ?? "general")
  const title = (s: SettingsSection) => t(`settings.section.${s}` as MessageKey)

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closing()) props.onClose()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  return (
    <div
      class={styles.page}
      role="dialog"
      aria-label={t("settings.title")}
      data-closing={closing()}
      data-testid="settings"
    >
      <nav class={styles.nav} aria-label={t("settings.title")}>
        <div class={styles.navTitle}>{t("settings.title")}</div>
        <For each={sections}>
          {(s) => (
            <button
              type="button"
              class={styles.navItem}
              aria-current={section() === s ? "page" : undefined}
              data-testid={`settings-nav-${s}`}
              onClick={() => setSection(s)}
            >
              {title(s)}
            </button>
          )}
        </For>
      </nav>
      <section class={styles.content} aria-label={title(section())}>
        <h1 class={styles.heading}>{title(section())}</h1>
        <SwitchCase fallback={props.extra?.[section()]?.() ?? <Later />}>
          <Match when={section() === "general"}>
            <General />
          </Match>
          <Match when={section() === "appearance"}>
            <Appearance />
          </Match>
          <Match when={section() === "data"}>
            <Data />
          </Match>
          <Match when={section() === "about"}>
            <About />
          </Match>
        </SwitchCase>
      </section>
      <IconButton
        class={styles.close}
        label={t("settings.close")}
        onClick={props.onClose}
        data-testid="settings-close"
      >
        <X size={18} />
      </IconButton>
    </div>
  )
}
