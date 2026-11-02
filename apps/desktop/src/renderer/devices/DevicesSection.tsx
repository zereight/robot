import {
  type ClientEntry,
  MAX_CLIENTS,
  MAX_SERVERS,
  type MessageKey,
  type ServerEntry,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import settingsStyles from "../settings/settings.module.css"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Presence } from "../ui/Presence.tsx"
import { ConnectDialog } from "./ConnectDialog.tsx"
import styles from "./devices.module.css"
import { PairDialog } from "./PairDialog.tsx"
import { SyncRow } from "./SyncRow.tsx"

const ClientRow = (props: { client: ClientEntry }) => {
  const { t } = useApp()
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
        <Button
          onClick={() => call("devices.client.remove", { id: props.client.id })}
          data-testid="client-remove"
        >
          {t("devices.client.remove")}
        </Button>
      </div>
    </li>
  )
}

const ServerRow = (props: { entry: ServerEntry }) => {
  const { t } = useApp()
  const [editing, setEditing] = createSignal(false)
  const [text, setText] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()

  const stateLine = () => {
    const e = props.entry
    if (e.state === "update_app") {
      return e.updateSide === "this"
        ? t("link.update.this")
        : t("link.update.server", { name: e.name })
    }
    return t(`devices.state.${e.state}` as MessageKey)
  }

  const save = async () => {
    setError(undefined)
    try {
      await call("devices.server.setAddresses", {
        id: props.entry.id,
        addresses: text()
          .split("\n")
          .map((a) => a.trim())
          .filter(Boolean),
      })
      setEditing(false)
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <li class={styles.item} data-testid="server-row" data-name={props.entry.name}>
      <div class={styles.itemMain} style={{ flex: 1 }}>
        <span class={styles.itemName}>{props.entry.name}</span>
        <span class={styles.itemMeta} data-testid="server-row-state" data-state={props.entry.state}>
          {stateLine()}
        </span>
        <Show
          when={editing()}
          fallback={
            <span class={styles.itemMeta} data-testid="server-row-addresses">
              {props.entry.addresses.join(", ")}
            </span>
          }
        >
          <label class={styles.field}>
            <span class={styles.fieldLabel}>{t("devices.server.addresses")}</span>
            <textarea
              class={styles.textarea}
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              data-testid="server-addresses-input"
            />
            <span class={styles.hint}>{t("devices.server.addresses.hint")}</span>
          </label>
          <Show when={error()}>
            {(err) => (
              <p class={styles.error} role="alert" data-testid="server-addresses-error">
                {t(err().key, err().params)}
              </p>
            )}
          </Show>
          <div class={styles.actions}>
            <Button variant="primary" onClick={save} data-testid="server-addresses-save">
              {t("devices.server.save")}
            </Button>
            <Button onClick={() => setEditing(false)}>{t("devices.server.cancel")}</Button>
          </div>
        </Show>
        <Show when={!editing()}>
          <SyncRow linkId={props.entry.id} name={props.entry.name} state={props.entry.state} />
        </Show>
      </div>
      <Show when={!editing()}>
        <div class={styles.actions}>
          <Button
            onClick={() => {
              setText(props.entry.addresses.join("\n"))
              setError(undefined)
              setEditing(true)
            }}
            data-testid="server-edit"
          >
            {t("devices.server.edit")}
          </Button>
          <Button
            onClick={() => call("devices.server.remove", { id: props.entry.id })}
            data-testid="server-remove"
          >
            {t("devices.server.remove")}
          </Button>
        </div>
      </Show>
    </li>
  )
}

/** Settings > Devices (spec 013, 012). */
export const DevicesSection = () => {
  const { t } = useApp()
  const devices = useDevices()
  const [pairOpen, setPairOpen] = createSignal(false)
  const [connectOpen, setConnectOpen] = createSignal(false)
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
                <Button onClick={() => setConnectOpen(true)} data-testid="connect-open">
                  {t("devices.connect")}
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

            <h2 class={styles.title}>
              {t("devices.servers")}
              <span class={styles.count}>
                {t("devices.count", { count: s().servers.length, max: MAX_SERVERS })}
              </span>
            </h2>
            <p class={styles.hint}>{t("devices.limit.servers", { max: MAX_SERVERS })}</p>
            <Show
              when={s().servers.length > 0}
              fallback={
                <p class={styles.hint} data-testid="servers-empty">
                  {t("devices.servers.empty")}
                </p>
              }
            >
              <ul class={styles.list} data-testid="servers-list">
                <For each={s().servers}>{(entry) => <ServerRow entry={entry} />}</For>
              </ul>
            </Show>
          </>
        )}
      </Show>
      <Presence when={pairOpen()}>
        {() => <PairDialog accept={state()?.accept ?? false} onClose={() => setPairOpen(false)} />}
      </Presence>
      <Presence when={connectOpen()}>
        {() => <ConnectDialog onClose={() => setConnectOpen(false)} />}
      </Presence>
    </div>
  )
}
