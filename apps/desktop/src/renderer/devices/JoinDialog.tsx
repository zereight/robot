import type { MessageKey } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./devices.module.css"

/** "Allow <device name>?" for the oldest device that waits (spec 012, Pair, step 4). */
export const JoinDialog = () => {
  const { t } = useApp()
  const devices = useDevices()
  // "Let <name> create and change agents" is on at first, for each new request (spec 012).
  const [canChange, setCanChange] = createSignal(true)
  return (
    <Presence when={devices.requests()[0]}>
      {(request) => (
        <Dialog
          label={t("join.title", { name: request.name })}
          onClose={() => {}}
          dismissible={false}
          testId="join-dialog"
        >
          <div class={styles.dialogBody}>
            <h2 style={{ margin: 0, "font-size": "1.1rem" }}>
              {t("join.title", { name: request.name })}
            </h2>
            <p>
              {t("join.body", {
                name: request.name,
                kind: t(`devices.kind.${request.kind}` as MessageKey),
              })}
            </p>
            <Show when={request.twoWay}>
              <p data-testid="join-two-way">{t("join.body.twoWay", { name: request.name })}</p>
            </Show>
            <div class={styles.switchRow}>
              <span class={styles.fieldLabel}>{t("join.canChange", { name: request.name })}</span>
              <Switch
                label={t("join.canChange", { name: request.name })}
                checked={canChange()}
                onChange={setCanChange}
                testId="join-can-change"
              />
            </div>
            <Show when={canChange()}>
              <p class={styles.hint} data-testid="join-can-change-body">
                {t("join.canChange.body", { name: request.name })}
              </p>
            </Show>
            <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
              <Button
                onClick={() => {
                  devices.decide(request.id, false)
                  setCanChange(true)
                }}
                data-testid="join-deny"
              >
                {t("join.deny")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  devices.decide(request.id, true, canChange())
                  setCanChange(true)
                }}
                data-testid="join-allow"
              >
                {t("join.allow")}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Presence>
  )
}
