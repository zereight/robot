import { type ClientEntry, MAX_CLIENTS, type MessageKey } from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import settingsStyles from "../settings/settings.module.css"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./devices.module.css"
import { PairDialog } from "./PairDialog.tsx"

const ClientRow = (props: { client: ClientEntry }) => {
  const { t } = useApp()
  // The danger button of the row asks first (spec 000, "Danger buttons").
  const [removing, setRemoving] = createSignal(false)
  return (
    <li class={styles.item} data-testid="client-row" data-name={props.client.name}>
      <div class={styles.itemMain}>
        <span class={styles.itemName}>{props.client.name}</span>
        <span class={styles.itemMeta}>
          {t(`devices.kind.${props.client.kind}` as MessageKey)} ·{" "}
          {props.client.online ? t("devices.client.online") : t("devices.client.offline")}
        </span>
        <div class={styles.switchRow} data-testid="client-change-row">
          <span class={styles.fieldLabel}>{t("devices.client.canChange")}</span>
          <Switch
            label={t("devices.client.canChange")}
            checked={props.client.canChange}
            disabled={props.client.canChangeLocked}
            onChange={(on) =>
              void call("devices.client.setChange", { id: props.client.id, canChange: on })
            }
            testId="client-can-change"
          />
        </div>
        <Show when={props.client.canChangeLocked}>
          <span class={styles.hint} data-testid="client-can-change-locked">
            {t("devices.client.canChange.locked")}
          </span>
        </Show>
      </div>
      <div class={styles.actions}>
        <Show
          when={removing()}
          fallback={
            <Button variant="danger" onClick={() => setRemoving(true)} data-testid="client-remove">
              {t("devices.client.remove")}
            </Button>
          }
        >
          <Confirm
            ask={t("devices.client.remove.ask", { name: props.client.name })}
            confirm={t("devices.client.remove")}
            keep={t("common.keep")}
            onConfirm={() => {
              setRemoving(false)
              void call("devices.client.remove", { id: props.client.id })
            }}
            onKeep={() => setRemoving(false)}
            testId="client-remove-ask"
            confirmTestId="client-remove-confirm"
            keepTestId="client-remove-keep"
          />
        </Show>
      </div>
    </li>
  )
}

/** Settings > Devices (spec 013, 012). */
export const DevicesSection = () => {
  const { t } = useApp()
  const devices = useDevices()
  const [pairOpen, setPairOpen] = createSignal(false)
  const [name, setName] = createSignal<string>()

  const state = () => devices.state()
  const shownName = () => name() ?? state()?.self.name ?? ""
  const saveName = async () => {
    const value = name()
    if (value === undefined) return
    setName(undefined)
    await call("devices.update", { name: value })
  }

  return (
    <div data-testid="devices-section">
      <Show when={state()}>
        {(s) => (
          <>
            <div class={settingsStyles.row} data-testid="device-self">
              <div>
                <div class={settingsStyles.label}>{t("devices.name")}</div>
                <div class={styles.hint}>{t("devices.name.hint")}</div>
              </div>
              <input
                class={`${styles.input} ${styles.nameInput}`}
                type="text"
                maxLength={40}
                aria-label={t("devices.name")}
                value={shownName()}
                onInput={(e) => setName(e.currentTarget.value)}
                onBlur={saveName}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                data-testid="device-name"
              />
            </div>
            <div class={settingsStyles.row}>
              <div>
                <div class={settingsStyles.label}>{t("devices.accept")}</div>
                <div class={styles.hint}>{t("devices.accept.hint")}</div>
              </div>
              <Switch
                label={t("devices.accept")}
                checked={s().accept}
                onChange={(accept) => call("devices.update", { accept })}
                testId="device-accept"
              />
            </div>
            <div class={styles.block}>
              <div class={styles.buttons}>
                <Button variant="primary" onClick={() => setPairOpen(true)} data-testid="pair-open">
                  {t("devices.pair")}
                </Button>
              </div>
              <p class={styles.hint} data-testid="devices-vpn">
                {t("devices.vpn")}
              </p>
            </div>

            <h2 class={styles.title}>
              {t("devices.clients")}
              <span class={styles.count}>
                {t("devices.count", { count: s().clients.length, max: MAX_CLIENTS })}
              </span>
            </h2>
            <p class={styles.hint}>{t("devices.limit.clients", { max: MAX_CLIENTS })}</p>
            <Show
              when={s().clients.length > 0}
              fallback={
                <p class={styles.hint} data-testid="clients-empty">
                  {t("devices.clients.empty")}
                </p>
              }
            >
              <ul class={styles.list} data-testid="clients-list">
                <For each={s().clients}>{(client) => <ClientRow client={client} />}</For>
              </ul>
            </Show>
          </>
        )}
      </Show>
      <Presence when={pairOpen()}>
        {() => <PairDialog accept={state()?.accept ?? false} onClose={() => setPairOpen(false)} />}
      </Presence>
    </div>
  )
}
