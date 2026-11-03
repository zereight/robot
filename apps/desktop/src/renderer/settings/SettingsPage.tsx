import {
  AGENTS_AT_ONCE_MAX,
  AGENTS_AT_ONCE_MIN,
  isAgentsAtOnce,
  isStepLimit,
  type LicenseEntry,
  type MessageKey,
  type MessageParams,
  SILENT_LIMITS,
  type SilentLimit,
  STEP_LIMIT_MAX,
  STEP_LIMIT_MIN,
} from "@robot/shared"
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
import { ActionLogSection } from "./ActionLogSection.tsx"
import { BrowserProfilesSection } from "./BrowserProfilesSection.tsx"
import { DecisionSection } from "./DecisionSection.tsx"
import { SavedSecretsSection } from "./SavedSecretsSection.tsx"
import styles from "./settings.module.css"
import { TeamsSection } from "./TeamsSection.tsx"

export const sections = [
  "general",
  "appearance",
  "providers",
  "decision",
  "teams",
  "devices",
  "notifications",
  "archive",
  "browser",
  "permissions",
  "skills",
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

/**
 * "Agents working at once": a whole number from 1 to 8 (spec 005, 013). A number out of range
 * shows the reason, and the old value stays.
 */
const AgentsAtOnce = () => {
  const app = useApp()
  const { t } = app
  const [draft, setDraft] = createSignal<string>()
  const shown = () => draft() ?? String(app.settings.agentsAtOnce)
  const parsed = () => (/^\d+$/.test(shown().trim()) ? Number(shown().trim()) : Number.NaN)
  const invalid = () => draft() !== undefined && !isAgentsAtOnce(parsed())
  const commit = () => {
    const value = parsed()
    if (isAgentsAtOnce(value) && value !== app.settings.agentsAtOnce)
      app.update({ agentsAtOnce: value })
    setDraft(undefined)
  }
  return (
    <Row
      label={t("settings.agentsAtOnce")}
      hint={invalid() ? t("settings.agentsAtOnce.invalid") : t("settings.agentsAtOnce.hint")}
      testId="setting-agents-at-once-row"
    >
      <input
        class={styles.number}
        type="number"
        inputMode="numeric"
        min={AGENTS_AT_ONCE_MIN}
        max={AGENTS_AT_ONCE_MAX}
        step={1}
        value={shown()}
        aria-label={t("settings.agentsAtOnce")}
        aria-invalid={invalid()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        data-testid="setting-agents-at-once"
      />
    </Row>
  )
}

/** The step limit of a task: a whole number from 20 to 2000 (spec 013). */
const StepLimit = () => {
  const app = useApp()
  const { t } = app
  const [draft, setDraft] = createSignal<string>()
  const shown = () => draft() ?? String(app.settings.stepLimit)
  const parsed = () => (/^\d+$/.test(shown().trim()) ? Number(shown().trim()) : Number.NaN)
  const invalid = () => draft() !== undefined && !isStepLimit(parsed())
  /** Saves a valid number when the user leaves the field or presses Enter. */
  const commit = () => {
    const value = parsed()
    if (isStepLimit(value) && value !== app.settings.stepLimit) app.update({ stepLimit: value })
    setDraft(undefined)
  }
  return (
    <Row
      label={t("settings.stepLimit")}
      hint={invalid() ? t("settings.stepLimit.invalid") : t("settings.stepLimit.hint")}
      testId="setting-step-limit-row"
    >
      <input
        class={styles.number}
        type="number"
        inputMode="numeric"
        min={STEP_LIMIT_MIN}
        max={STEP_LIMIT_MAX}
        step={1}
        value={shown()}
        aria-label={t("settings.stepLimit")}
        aria-invalid={invalid()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        data-testid="setting-step-limit"
      />
    </Row>
  )
}

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
      <Row label={t("settings.duringTurn")} hint={t("settings.duringTurn.hint")}>
        <Segmented
          label={t("settings.duringTurn")}
          testId="setting-during-turn"
          value={app.settings.duringTurn}
          onChange={(duringTurn) => app.update({ duringTurn })}
          options={[
            { value: "join", label: t("settings.duringTurn.join") },
            { value: "queue", label: t("settings.duringTurn.queue") },
          ]}
        />
      </Row>
      <Row label={t("settings.autoCompact")} hint={t("settings.autoCompact.hint")}>
        <Switch
          label={t("settings.autoCompact")}
          testId="setting-auto-compact"
          checked={app.settings.autoCompact}
          onChange={(autoCompact) => app.update({ autoCompact })}
        />
      </Row>
      <Row label={t("settings.silentLimit")} hint={t("settings.silentLimit.hint")}>
        <Segmented
          label={t("settings.silentLimit")}
          testId="setting-silent-limit"
          value={String(app.settings.silentLimit)}
          onChange={(value) => app.update({ silentLimit: Number(value) as SilentLimit })}
          options={SILENT_LIMITS.map((minutes) => ({
            value: String(minutes),
            label:
              minutes === 0
                ? t("settings.silentLimit.never")
                : t("settings.silentLimit.option", { count: minutes }),
          }))}
        />
      </Row>
      <StepLimit />
      <AgentsAtOnce />
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
          <Match when={section() === "decision"}>
            <DecisionSection />
          </Match>
          <Match when={section() === "browser"}>
            <BrowserProfilesSection />
          </Match>
          <Match when={section() === "teams"}>
            <TeamsSection />
          </Match>
          <Match when={section() === "permissions"}>
            <SavedSecretsSection />
            <ActionLogSection />
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
