import {
  ISLAND_MODES,
  ISLAND_WIDTHS,
  type MessageKey,
  MUTE_CHOICES,
  type Mute,
  type MuteChoice,
  NOTIFY_KINDS,
} from "@robot/shared"
import { createResource, For, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { useUi } from "../state/ui.tsx"
import { Segmented, Switch } from "../ui/controls.tsx"
import styles from "./notifications.module.css"

/** The state of one mute as a choice for the select. */
const choiceOf = (mute: Mute | undefined, now: number): MuteChoice => {
  if (!mute) return "off"
  if (mute.until === null) return "forever"
  if (mute.until <= now) return "off"
  const left = mute.until - now
  return left <= 3_600_000 ? "1h" : left <= 8 * 3_600_000 ? "8h" : "1d"
}

const MuteSelect = (props: {
  label: string
  kind: Mute["kind"]
  id: string
  mutes: readonly Mute[]
  testId: string
}) => {
  const { t } = useApp()
  const current = () => props.mutes.find((m) => m.kind === props.kind && m.id === props.id)
  return (
    <label class={styles.muteRow}>
      <span>{props.label}</span>
      <select
        class={styles.select}
        value={choiceOf(current(), Date.now())}
        onChange={(e) =>
          call("notifications.setMute", {
            kind: props.kind,
            id: props.id,
            choice: e.currentTarget.value as MuteChoice,
          })
        }
        data-testid={props.testId}
      >
        <For each={MUTE_CHOICES}>
          {(c) => <option value={c}>{t(`settings.notify.mute.${c}` as MessageKey)}</option>}
        </For>
      </select>
    </label>
  )
}

export const NotificationsSection = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const channels = useChannels()
  const [mutes, { refetch }] = createResource(() => call("notifications.mutes"), {
    initialValue: [] as readonly Mute[],
  })
  onCleanup(window.robot.on("notifications.changed", () => void refetch()))
  const kinds = () => app.settings.notifyKinds

  return (
    <div class={styles.section} data-testid="notifications-section">
      <h2 class={styles.title}>{t("settings.notify.kinds")}</h2>
      <p class={styles.hint}>{t("settings.notify.hint")}</p>
      <For each={NOTIFY_KINDS}>
        {(kind) => (
          <div class={styles.row}>
            <span>{t(`settings.notify.kind.${kind}` as MessageKey)}</span>
            <Switch
              label={t(`settings.notify.kind.${kind}` as MessageKey)}
              checked={kinds()[kind] !== false}
              onChange={(on) => app.update({ notifyKinds: { ...kinds(), [kind]: on } })}
              testId={`notify-${kind}`}
            />
          </div>
        )}
      </For>

      <Show when={app.info.platform === "darwin"}>
        <h2 class={styles.title}>{t("settings.notify.island")}</h2>
        <Segmented
          label={t("settings.notify.island")}
          value={app.settings.island}
          options={ISLAND_MODES.map((value) => ({
            value,
            label: t(`settings.notify.island.${value}` as MessageKey),
          }))}
          onChange={(island) => app.update({ island })}
          testId="notify-island"
        />
        <h2 class={styles.title}>{t("settings.notify.islandWidth")}</h2>
        <Segmented
          label={t("settings.notify.islandWidth")}
          value={app.settings.islandWidth}
          options={ISLAND_WIDTHS.map((value) => ({
            value,
            label: t(`settings.notify.islandWidth.${value}` as MessageKey),
          }))}
          onChange={(islandWidth) => app.update({ islandWidth })}
          testId="notify-island-width"
        />
      </Show>

      <h2 class={styles.title}>{t("settings.notify.mutes")}</h2>
      <p class={styles.hint}>{t("settings.notify.mutes.hint")}</p>
      <Show when={ui.server()}>
        {(server) => (
          <MuteSelect
            label={
              server().kind === "local"
                ? t("settings.notify.thisServer")
                : t("settings.notify.serverNamed", { name: server().name })
            }
            kind="server"
            id={server().id}
            mutes={mutes()}
            testId="mute-server"
          />
        )}
      </Show>
      <For each={channels.channels()}>
        {(c) => (
          <MuteSelect
            label={`# ${c.name}`}
            kind="channel"
            id={c.id}
            mutes={mutes()}
            testId={`mute-channel-${c.name}`}
          />
        )}
      </For>
    </div>
  )
}
