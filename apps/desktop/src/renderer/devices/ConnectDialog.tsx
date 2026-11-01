import type { ConnectProbe } from "@robot/shared"
import { Switch as Branch, createSignal, Match, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./devices.module.css"

type Step = "enter" | "checking" | "ask" | "waiting"

/** "Connect to a computer" (spec 012): a link, or an address and a code, then the two-way question. */
export const ConnectDialog = (props: { onClose: () => void; onDone?: () => void }) => {
  const { t } = useApp()
  const [step, setStep] = createSignal<Step>("enter")
  const [link, setLink] = createSignal("")
  const [address, setAddress] = createSignal("")
  const [code, setCode] = createSignal("")
  const [found, setFound] = createSignal<ConnectProbe>()
  const [twoWay, setTwoWay] = createSignal(true)
  const [error, setError] = createSignal<ErrorText>()

  const probe = async () => {
    setError(undefined)
    setStep("checking")
    try {
      const text = link().trim()
      setFound(
        await call(
          "devices.connect.probe",
          text ? { link: text } : { address: address().trim(), code: code() },
        ),
      )
      setStep("ask")
    } catch (e) {
      setError(describeError(e))
      setStep("enter")
    }
  }

  const finish = async () => {
    const found_ = found()
    if (!found_) return
    setError(undefined)
    setStep("waiting")
    try {
      await call("devices.connect.finish", { session: found_.session, twoWay: twoWay() })
      props.onDone?.()
      props.onClose()
    } catch (e) {
      setError(describeError(e))
      setStep("ask")
    }
  }

  const close = () => {
    const probe = found()
    if (probe && (step() === "ask" || step() === "waiting")) {
      void call("devices.connect.cancel", { session: probe.session }).catch(() => {})
    }
    props.onClose()
  }

  return (
    <Dialog label={t("connect.title")} onClose={close} testId="connect-dialog">
      <div class={styles.dialogBody}>
        <h2 style={{ margin: 0, "font-size": "1.1rem" }}>{t("connect.title")}</h2>
        <Branch>
          <Match when={step() === "enter" || step() === "checking"}>
            <p class={styles.hint}>{t("connect.intro")}</p>
            <label class={styles.field}>
              <span class={styles.fieldLabel}>{t("connect.link")}</span>
              <input
                class={styles.input}
                type="text"
                placeholder={t("connect.link.placeholder")}
                value={link()}
                onInput={(e) => setLink(e.currentTarget.value)}
                data-testid="connect-link"
              />
            </label>
            <span class={styles.divider}>{t("connect.or")}</span>
            <label class={styles.field}>
              <span class={styles.fieldLabel}>{t("connect.address")}</span>
              <input
                class={styles.input}
                type="text"
                placeholder={t("connect.address.placeholder")}
                value={address()}
                onInput={(e) => setAddress(e.currentTarget.value)}
                data-testid="connect-address"
              />
            </label>
            <label class={styles.field}>
              <span class={styles.fieldLabel}>{t("connect.code")}</span>
              <input
                class={styles.input}
                type="text"
                inputMode="numeric"
                autocomplete="off"
                maxLength={7}
                value={code()}
                onInput={(e) => setCode(e.currentTarget.value)}
                data-testid="connect-code"
              />
            </label>
          </Match>
          <Match when={step() === "ask" || step() === "waiting"}>
            <p class={styles.status} data-testid="connect-found">
              {t("connect.found", { name: found()?.name ?? "" })}
            </p>
            <Show when={found()?.kind === "computer"}>
              <div class={styles.switchRow}>
                <span class={styles.fieldLabel}>
                  {t("connect.twoWay.title", { name: found()?.name ?? "" })}
                </span>
                <Switch
                  label={t("connect.twoWay.label", { name: found()?.name ?? "" })}
                  checked={twoWay()}
                  onChange={setTwoWay}
                  testId="connect-two-way"
                />
              </div>
              <p class={styles.hint}>{t("connect.twoWay.body", { name: found()?.name ?? "" })}</p>
            </Show>
            <Show when={step() === "waiting"}>
              <p class={styles.status} role="status" data-testid="connect-waiting">
                {t("connect.waiting", { name: found()?.name ?? "" })}
              </p>
            </Show>
          </Match>
        </Branch>
        <Show when={step() === "checking"}>
          <p class={styles.status} role="status">
            {t("connect.checking")}
          </p>
        </Show>
        <Show when={error()}>
          {(err) => (
            <p class={styles.error} role="alert" data-testid="connect-error">
              {t(err().key, err().params)}
            </p>
          )}
        </Show>
        <div
          class="dialogActions"
          style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}
        >
          <Button onClick={close} data-testid="connect-cancel">
            {t("connect.cancel")}
          </Button>
          <Show when={step() === "enter" || step() === "checking"}>
            <Button
              variant="primary"
              disabled={
                step() === "checking" ||
                (link().trim() === "" && (address().trim() === "" || code().trim() === ""))
              }
              onClick={probe}
              data-testid="connect-next"
            >
              {t("connect.next")}
            </Button>
          </Show>
          <Show when={step() === "ask" || step() === "waiting"}>
            <Button
              variant="primary"
              disabled={step() === "waiting"}
              onClick={finish}
              data-testid="connect-finish"
            >
              {t("connect.finish")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
