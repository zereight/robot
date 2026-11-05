import { Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./devices.module.css"
import { CountsLine } from "./SyncRow.tsx"

/** "Sync with <name>?" for the oldest request that waits (spec 019, Turn sync on, step 3). */
export const SyncRequestDialog = () => {
  const { t } = useApp()
  const devices = useDevices()
  return (
    <Presence when={devices.sync.requests()[0]}>
      {(request) => (
        <Dialog
          label={t("sync.dialog.title", { name: request.name })}
          onClose={() => {}}
          dismissible={false}
          testId="sync-request-dialog"
        >
          <div class={styles.dialogBody}>
            <h2 style={{ margin: 0, "font-size": "1.1rem" }}>
              {t("sync.dialog.title", { name: request.name })}
            </h2>
            <p data-testid="sync-request-mode" data-mode={request.mode}>
              {t(`sync.request.${request.mode}`, { name: request.name })}
            </p>
            <div class={styles.block}>
              <span class={styles.hint}>
                {t("sync.dialog.thisComputer")}: <CountsLine counts={request.here} />
              </span>
              <span class={styles.hint}>
                {request.name}: <CountsLine counts={request.there} />
              </span>
              <Show when={request.drops > 0}>
                <span class={styles.hint} data-testid="sync-request-drops">
                  {t("sync.items.removedHere", { count: request.drops })}
                </span>
              </Show>
            </div>
            <p class={styles.hint}>{t("sync.request.syncs")}</p>
            <p class={styles.hint}>{t("sync.request.notSyncs")}</p>
            <p class={styles.hint}>{t("sync.request.arrive", { name: request.name })}</p>
            <p data-testid="sync-request-power">
              {t("sync.request.power", { name: request.name })}
            </p>
            <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
              <Button
                onClick={() => devices.sync.decide(request.id, false)}
                data-testid="sync-request-deny"
              >
                {t("sync.request.deny")}
              </Button>
              <Button
                variant="primary"
                onClick={() => devices.sync.decide(request.id, true)}
                data-testid="sync-request-allow"
              >
                {t("sync.request.allow")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Presence>
  )
}

/** "<name> wants to delete 8 agents and channels here." (spec 019, Delete). */
export const SyncGuardDialog = () => {
  const { t } = useApp()
  const devices = useDevices()
  const decide = (remove: boolean) => call("sync.guard.decide", { remove }).catch(() => {})
  return (
    <Presence when={devices.sync.guard()}>
      {(guard) => (
        <Dialog
          label={t("sync.guard.title")}
          onClose={() => {}}
          dismissible={false}
          testId="sync-guard-dialog"
        >
          <div class={styles.dialogBody}>
            <h2 style={{ margin: 0, "font-size": "1.1rem" }}>{t("sync.guard.title")}</h2>
            <p data-testid="sync-guard-body">
              {t("sync.guard.body", { name: guard.peerName, count: guard.count })}
            </p>
            <p class={styles.hint}>{t("sync.guard.files")}</p>
            <p class={styles.hint}>{t("sync.guard.keepHint", { name: guard.peerName })}</p>
            <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
              <Button onClick={() => decide(false)} data-testid="sync-guard-keep">
                {t("sync.guard.keep")}
              </Button>
              <Button variant="danger" onClick={() => decide(true)} data-testid="sync-guard-delete">
                {t("sync.guard.delete")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Presence>
  )
}
