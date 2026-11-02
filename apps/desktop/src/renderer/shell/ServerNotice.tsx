import { createSignal, Match, Show, Switch } from "solid-js"
import { ConnectDialog } from "../devices/ConnectDialog.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./shell.module.css"

/** The strip above a linked server that is not online: what is wrong, and "Pair again". */
export const ServerNotice = () => {
  const { t } = useApp()
  const ui = useUi()
  const [pairing, setPairing] = createSignal(false)
  return (
    <Show when={ui.serverOffline() ? ui.server() : undefined}>
      {(server) => (
        <div
          class={styles.serverNotice}
          role="status"
          data-testid="server-notice"
          data-state={server().state}
        >
          <Switch>
            <Match when={server().state === "connecting"}>
              <span>{t("link.state.connecting", { name: server().name })}</span>
            </Match>
            <Match when={server().state === "reconnecting"}>
              <span>{t("link.state.reconnecting", { name: server().name })}</span>
            </Match>
            <Match when={server().state === "offline"}>
              <span>{t("link.state.offline.cache")}</span>
            </Match>
            <Match when={server().state === "not_allowed"}>
              <span>{t("link.state.not_allowed", { name: server().name })}</span>
              <Button variant="primary" onClick={() => setPairing(true)} data-testid="pair-again">
                {t("link.pairAgain")}
              </Button>
            </Match>
            <Match when={server().state === "update_app"}>
              <span>
                {server().updateSide === "this"
                  ? t("link.update.this")
                  : t("link.update.server", { name: server().name })}
              </span>
            </Match>
          </Switch>
          <Presence when={pairing()}>
            {() => <ConnectDialog onClose={() => setPairing(false)} />}
          </Presence>
        </div>
      )}
    </Show>
  )
}
