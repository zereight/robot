import { type CompactOff, compactDue, type MessageKey, meterShare } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import styles from "../agents/agents.module.css"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { type MenuItem, PopupMenu } from "../ui/Menu.tsx"
import { createMeter, threadPart } from "./threads.ts"

const RING = 16
const STROKE = 2.5
const RADIUS = (RING - STROKE) / 2
const LENGTH = 2 * Math.PI * RADIUS

/** The words of a reason why Compact is off (spec 003). */
export const compactOffKey = (off: CompactOff) => `chat.compact.off.${off}` as MessageKey

/**
 * The context meter in the chat header (spec 003, "Context meter"): a small ring with the numbers
 * in its label. A click opens Compact, or the reason why it is off.
 */
export const ContextMeter = (props: { agentId: string; threadId: string | null }) => {
  const app = useApp()
  const { t } = app
  const meter = createMeter(
    () => props.agentId,
    () => props.threadId,
  )
  const [position, setPosition] = createSignal<{ top: number; left: number }>()
  const [error, setError] = createSignal<ErrorText>()
  let trigger: HTMLButtonElement | undefined

  const share = () => {
    const m = meter()
    return m ? meterShare(m.used, m.size) : null
  }
  const number = (n: number) => new Intl.NumberFormat(app.locale()).format(n)
  const label = () => {
    const m = meter()
    const s = share()
    if (!m || m.size === null) return t("chat.meter.sizeUnknown")
    if (m.used === null || s === null) return t("chat.meter.unknown", { size: number(m.size) })
    return t("chat.meter.used", {
      used: number(m.used),
      size: number(m.size),
      percent: Math.round(s * 100),
    })
  }

  const compact = async () => {
    setError(undefined)
    try {
      await call("chat.compact", { agentId: props.agentId, ...threadPart(props.threadId) })
    } catch (e) {
      setError(describeError(e))
    }
  }
  const items = (): MenuItem[] => {
    const off = meter()?.off ?? null
    const list: MenuItem[] = [
      { label: label(), onSelect: () => {}, heading: true },
      {
        label: t("chat.compact"),
        onSelect: () => void compact(),
        disabled: off !== null || meter()?.compacting === true,
        testId: "compact",
      },
    ]
    if (off)
      list.push({
        label: t(compactOffKey(off)),
        onSelect: () => {},
        heading: true,
        testId: "compact-off",
      })
    return list
  }
  const toggle = () => {
    if (position()) return setPosition(undefined)
    const box = trigger?.getBoundingClientRect()
    if (box) setPosition({ top: box.bottom + 4, left: box.left })
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={styles.meter}
        aria-label={label()}
        title={label()}
        aria-haspopup="menu"
        aria-expanded={position() !== undefined}
        onClick={toggle}
        data-testid="context-meter"
        data-used={meter()?.used ?? ""}
        data-level={compactDue(meter()?.used ?? null, meter()?.size ?? null) ? "high" : undefined}
      >
        <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} aria-hidden="true">
          <circle
            class={styles.meterTrack}
            cx={RING / 2}
            cy={RING / 2}
            r={RADIUS}
            fill="none"
            stroke-width={STROKE}
          />
          <circle
            class={styles.meterFill}
            cx={RING / 2}
            cy={RING / 2}
            r={RADIUS}
            fill="none"
            stroke-width={STROKE}
            stroke-dasharray={`${LENGTH}`}
            stroke-dashoffset={`${LENGTH * (1 - (share() ?? 0))}`}
            transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
          />
        </svg>
      </button>
      <Show when={position()}>
        {(at) => (
          <PopupMenu
            items={items()}
            top={at().top}
            left={at().left}
            label={t("chat.meter")}
            testId="meter-menu"
            onClose={(refocus) => {
              setPosition(undefined)
              if (refocus) trigger?.focus()
            }}
          />
        )}
      </Show>
      <Show when={error()}>
        {(err) => (
          <span class={styles.threadError} role="alert" data-testid="compact-error">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
    </>
  )
}
