import type { MessageKey, SyncCounts, SyncMode, SyncPreview, SyncStatus } from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./devices.module.css"

/** The counts of one computer, for the start dialog and the request dialog. */
export const CountsLine = (props: { counts: SyncCounts; testId?: string }) => {
  const { t, locale } = useApp()
  const n = (v: number) => new Intl.NumberFormat(locale()).format(v)
  return (
    <span data-testid={props.testId}>
      {t("sync.counts", {
        agents: n(props.counts.agents),
        messages: n(props.counts.messages),
      })}
    </span>
  )
}

const StartDialog = (props: { linkId: string; name: string; onClose: () => void }) => {
  const { t } = useApp()
  const devices = useDevices()
  const [preview, setPreview] = createSignal<SyncPreview>()
  const [error, setError] = createSignal<unknown>()
  const [mode, setMode] = createSignal<SyncMode>("merge")
  void call("sync.preview", { linkId: props.linkId }).then(setPreview, setError)

  const begin = () => {
    // The answer comes when the other user decided. The row shows the wait.
    void devices.sync.start(props.linkId, mode())
    props.onClose()
  }

  const choice = (value: SyncMode, label: string, hint: string, removed?: string) => (
    <label class={styles.choice} data-testid={`sync-mode-${value}`}>
      <input
        type="radio"
        name="sync-mode"
        checked={mode() === value}
        onChange={() => setMode(value)}
        data-testid={`sync-mode-${value}-input`}
      />
      <span class={styles.choiceText}>
        <span class={styles.fieldLabel}>{label}</span>
        <span class={styles.hint}>{hint}</span>
        <Show when={removed}>
          <span class={styles.hint} data-testid={`sync-mode-${value}-removed`}>
            {removed}
          </span>
        </Show>
      </span>
    </label>
  )

  return (
    <Dialog
      label={t("sync.dialog.title", { name: props.name })}
      onClose={props.onClose}
      testId="sync-start-dialog"
    >
      <div class={styles.dialogBody}>
        <h2 style={{ margin: 0, "font-size": "1.1rem" }}>
          {t("sync.dialog.title", { name: props.name })}
        </h2>
        <Show
          when={preview()}
          fallback={
            <p class={styles.status} role={error() ? "alert" : "status"}>
              {error() ? t(describeError(error()).key) : t("sync.dialog.loading")}
            </p>
          }
        >
          {(p) => (
            <>
              <div class={styles.block}>
                <span class={styles.fieldLabel}>{t("sync.dialog.holds")}</span>
                <span class={styles.hint}>
                  {t("sync.dialog.thisComputer")}:{" "}
                  <CountsLine counts={p().here} testId="sync-here" />
                </span>
                <span class={styles.hint}>
                  {p().peerName}: <CountsLine counts={p().there} testId="sync-there" />
                </span>
              </div>
              <div class={styles.block}>
                {choice("merge", t("sync.mode.merge"), t("sync.mode.merge.hint"))}
                {choice(
                  "take",
                  t("sync.mode.take", { name: p().peerName }),
                  t("sync.mode.take.hint", { name: p().peerName }),
                  t("sync.items.removedHere", { count: p().onlyHere }),
                )}
                {choice(
                  "send",
                  t("sync.mode.send", { name: p().peerName }),
                  t("sync.mode.send.hint", { name: p().peerName }),
                  t("sync.items.removedThere", { name: p().peerName, count: p().onlyThere }),
                )}
              </div>
              <Show when={p().oneWay}>
                <p class={styles.hint} data-testid="sync-one-way">
                  {t("sync.oneWay", { name: p().peerName })}
                </p>
              </Show>
            </>
          )}
        </Show>
        <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
          <Button onClick={props.onClose} data-testid="sync-start-cancel">
            {t("sync.dialog.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!preview()}
            onClick={begin}
            data-testid="sync-start-confirm"
          >
            {t("sync.dialog.start")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** The sync line of one linked computer in Settings > Devices (spec 019, States). */
export const SyncRow = (props: { linkId: string; name: string; state: string }) => {
  const { t, locale } = useApp()
  const devices = useDevices()
  const [open, setOpen] = createSignal(false)
  const status = (): SyncStatus | undefined => devices.sync.of(props.linkId)
  const other = () => {
    const active = devices.sync.active()
    return active && active.linkId !== props.linkId ? active : undefined
  }
  const otherName = () => devices.state()?.servers.find((s) => s.id === other()?.linkId)?.name ?? ""
  const n = (v: number) => new Intl.NumberFormat(locale()).format(v)
  const time = (at: number) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(at)

  const line = (s: SyncStatus): { text: string; key: MessageKey } => {
    switch (s.state) {
      case "offered":
        return { text: t("sync.state.offered", { name: props.name }), key: "sync.state.offered" }
      case "copying":
        return s.total === 0
          ? { text: t("sync.state.preparing"), key: "sync.state.preparing" }
          : {
              text: t("sync.state.copying", { done: n(s.done), total: n(s.total) }),
              key: "sync.state.copying",
            }
      case "live":
        return { text: t("sync.state.live"), key: "sync.state.live" }
      case "waiting":
        return { text: t("sync.state.waiting", { name: props.name }), key: "sync.state.waiting" }
      case "paused":
        return { text: t("sync.state.paused"), key: "sync.state.paused" }
      case "attention":
        switch (s.attention) {
          case "update_this":
            return { text: t("link.update.this"), key: "link.update.this" }
          case "update_other":
            return {
              text: t("link.update.server", { name: props.name }),
              key: "link.update.server",
            }
          case "clock":
            return {
              text: t("sync.attention.clock", { name: props.name, minutes: s.clockMinutes }),
              key: "sync.attention.clock",
            }
          default:
            return { text: t("sync.attention.deletions"), key: "sync.attention.deletions" }
        }
      default:
        return { text: "", key: "sync.title" }
    }
  }

  const act = (method: "sync.pause" | "sync.resume" | "sync.stop" | "sync.cancelOffer") =>
    call(method, { linkId: props.linkId }).catch(() => {})

  return (
    <div class={styles.syncRow} data-testid="sync-row">
      <Show
        when={status()}
        fallback={
          <span class={styles.hint} data-testid="sync-state" data-state="off">
            {t("sync.title")}
          </span>
        }
      >
        {(s) => (
          <>
            <Show
              when={s().state !== "off"}
              fallback={
                <>
                  <Show when={s().denied}>
                    <p class={styles.status} role="status" data-testid="sync-denied">
                      {t("sync.denied", { name: props.name })}
                      <Button
                        class={styles.inlineButton}
                        onClick={() => call("sync.dismiss", { linkId: props.linkId })}
                        data-testid="sync-dismiss"
                      >
                        {t("sync.dismiss")}
                      </Button>
                    </p>
                  </Show>
                  <Show when={s().stoppedBy}>
                    <p class={styles.status} role="status" data-testid="sync-stopped-by">
                      {t("sync.stoppedBy", { name: props.name })}
                      <Button
                        class={styles.inlineButton}
                        onClick={() => call("sync.dismiss", { linkId: props.linkId })}
                        data-testid="sync-dismiss"
                      >
                        {t("sync.dismiss")}
                      </Button>
                    </p>
                  </Show>
                  <Show when={devices.sync.errors()[props.linkId]}>
                    {(err) => (
                      <p class={styles.error} role="alert" data-testid="sync-error">
                        {t(describeError(err()).key)}
                      </p>
                    )}
                  </Show>
                  <div class={styles.syncLine}>
                    <span class={styles.hint} data-testid="sync-state" data-state="off">
                      {other()
                        ? t("sync.busy", { name: otherName() })
                        : props.state === "online"
                          ? t("sync.hint")
                          : t("sync.start.offline", { name: props.name })}
                    </span>
                    <Button
                      disabled={props.state !== "online" || other() !== undefined}
                      onClick={() => setOpen(true)}
                      data-testid="sync-start"
                    >
                      {t("sync.start")}
                    </Button>
                  </div>
                </>
              }
            >
              <div class={styles.syncLine}>
                <span
                  class={styles.syncState}
                  data-testid="sync-state"
                  data-state={s().state}
                  data-done={s().done}
                  data-total={s().total}
                  role="status"
                >
                  {line(s()).text}
                  <Show when={s().state === "live" && s().lastSyncedAt}>
                    {(at) => (
                      <span class={styles.hint} data-testid="sync-time">
                        {" · "}
                        {t("sync.state.liveTime", { time: time(at()) })}
                      </span>
                    )}
                  </Show>
                  <Show when={s().state === "waiting" && s().ownSwitchOff}>
                    <span class={styles.hint} data-testid="sync-own-off">
                      {" · "}
                      {t("sync.state.waitingOwnOff")}
                    </span>
                  </Show>
                </span>
                <div class={styles.actions}>
                  <Show when={s().state === "offered"}>
                    <Button onClick={() => act("sync.cancelOffer")} data-testid="sync-cancel">
                      {t("sync.cancel")}
                    </Button>
                  </Show>
                  <Show when={["copying", "live", "waiting", "attention"].includes(s().state)}>
                    <Button onClick={() => act("sync.pause")} data-testid="sync-pause">
                      {t("sync.pause")}
                    </Button>
                  </Show>
                  <Show when={s().state === "paused"}>
                    <Button onClick={() => act("sync.resume")} data-testid="sync-resume">
                      {t("sync.resume")}
                    </Button>
                  </Show>
                  <Show when={s().state !== "offered"}>
                    <Button onClick={() => act("sync.stop")} data-testid="sync-stop">
                      {t("sync.stop")}
                    </Button>
                  </Show>
                </div>
              </div>
            </Show>
            <Show when={s().state !== "off" && s().state !== "offered"}>
              <ChangeList />
            </Show>
          </>
        )}
      </Show>
      <Presence when={open()}>
        {() => (
          <StartDialog linkId={props.linkId} name={props.name} onClose={() => setOpen(false)} />
        )}
      </Presence>
    </div>
  )
}

/** The newest changes that came from the other computer (spec 019, Concepts). */
const ChangeList = () => {
  const { t, locale } = useApp()
  const devices = useDevices()
  const time = (at: number) => new Intl.DateTimeFormat(locale(), { timeStyle: "medium" }).format(at)
  return (
    <Show when={devices.sync.changes().length > 0}>
      <ul class={styles.changeList} data-testid="sync-changes">
        <For each={devices.sync.changes()}>
          {(c) => (
            <li
              class={styles.change}
              data-testid="sync-change"
              data-kind={c.kind}
              data-name={c.name}
            >
              <span class={styles.hint}>{time(c.at)}</span>
              <span class={styles.changeText}>
                {t(`sync.change.${c.action}` as MessageKey, {
                  kind: t(`sync.kind.${c.kind}` as MessageKey),
                  name: c.name,
                })}
                <Show when={c.detail}>
                  {" "}
                  <span class={styles.hint} data-testid="sync-change-detail">
                    {t("sync.change.folder", { path: c.detail })}
                  </span>
                </Show>
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}
