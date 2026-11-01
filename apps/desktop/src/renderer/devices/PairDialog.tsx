import { groupCode, type MessageKey, type PairingState } from "@robot/shared"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./devices.module.css"
import { countdown } from "./format.ts"
import { QrCode } from "./QrCode.tsx"

const idle: PairingState = {
  active: false,
  code: "",
  expiresAt: 0,
  addresses: [],
  link: "",
  ended: null,
}

/** The pairing screen: QR code, code, addresses, "Copy link". */
export const PairDialog = (props: { accept: boolean; onClose: () => void }) => {
  const { t } = useApp()
  const [pairing, setPairing] = createSignal<PairingState>(idle)
  // The switch is off at first start. "Pair a device" turns it on after the user agrees.
  const [agreed, setAgreed] = createSignal(props.accept)
  const [now, setNow] = createSignal(Date.now())
  const [error, setError] = createSignal<ErrorText>()
  const [copied, setCopied] = createSignal(false)

  const start = async () => {
    setError(undefined)
    setCopied(false)
    try {
      setPairing(await call("devices.pair.start"))
    } catch (e) {
      setError(describeError(e))
    }
  }

  onMount(() => {
    const tick = setInterval(() => setNow(Date.now()), 500)
    const off = window.robot.on("devices.pairing", setPairing)
    onCleanup(() => {
      clearInterval(tick)
      off()
    })
    if (props.accept) void start()
  })

  const close = () => {
    void call("devices.pair.stop").catch(() => {})
    props.onClose()
  }

  return (
    <Dialog label={t("pair.title")} onClose={close} testId="pair-dialog">
      <div class={styles.dialogBody}>
        <h2 style={{ margin: 0, "font-size": "1.1rem" }}>{t("pair.title")}</h2>
        <Show
          when={agreed()}
          fallback={
            <>
              <h3 style={{ margin: 0, "font-size": "1rem" }}>{t("pair.turnOn.title")}</h3>
              <p>{t("pair.turnOn.body")}</p>
              <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
                <Button onClick={close} data-testid="pair-turn-on-cancel">
                  {t("pair.cancel")}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setAgreed(true)
                    void start()
                  }}
                  data-testid="pair-turn-on"
                >
                  {t("pair.turnOn.confirm")}
                </Button>
              </div>
            </>
          }
        >
          <Show
            when={pairing().active}
            fallback={
              <>
                <Show when={pairing().ended}>
                  {(reason) => (
                    <p class={styles.status} role="status" data-testid="pair-ended">
                      {t(`pair.ended.${reason()}` as MessageKey)}
                    </p>
                  )}
                </Show>
                <Show when={error()}>
                  {(err) => (
                    <p class={styles.error} role="alert">
                      {t(err().key, err().params)}
                    </p>
                  )}
                </Show>
                <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
                  <Button onClick={close} data-testid="pair-close">
                    {t("pair.done")}
                  </Button>
                  <Button variant="primary" onClick={start} data-testid="pair-new-code">
                    {t("pair.new")}
                  </Button>
                </div>
              </>
            }
          >
            <p class={styles.hint}>{t("pair.intro")}</p>
            <div class={styles.pairLayout}>
              <div class={styles.qr}>
                <QrCode text={pairing().link} label={t("pair.qr")} testId="pair-qr" />
              </div>
              <div class={styles.pairInfo}>
                <div>
                  <div class={styles.hint}>{t("pair.code")}</div>
                  <div class={styles.code} data-testid="pair-code" data-code={pairing().code}>
                    {groupCode(pairing().code)}
                  </div>
                </div>
                <div>
                  <div class={styles.hint}>{t("pair.addresses")}</div>
                  <ul class={styles.addressList} data-testid="pair-addresses">
                    <For each={pairing().addresses}>
                      {(a) => (
                        <li data-address={a.address}>
                          {a.address}
                          <span class={styles.addressLabel}>
                            {t(`pair.address.${a.label}` as MessageKey)}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </div>
            </div>
            <p class={styles.hint} data-testid="pair-left">
              {t("pair.left", { time: countdown(pairing().expiresAt - now()) })}
            </p>
            <p class={styles.hint}>{t("devices.vpn")}</p>
            <Show when={copied()}>
              <p class={styles.status} role="status" data-testid="pair-copied">
                {t("pair.copied")}
              </p>
            </Show>
            <span hidden data-testid="pair-link" data-link={pairing().link} />
            <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
              <Button onClick={close} data-testid="pair-close">
                {t("pair.done")}
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  await call("app.copy", { text: pairing().link })
                  setCopied(true)
                }}
                data-testid="pair-copy"
              >
                {t("pair.copyLink")}
              </Button>
            </div>
          </Show>
        </Show>
      </div>
    </Dialog>
  )
}
