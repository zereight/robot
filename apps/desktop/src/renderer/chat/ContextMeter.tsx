import {
  type ChatMeter,
  type CompactOff,
  compactDue,
  type MessageKey,
  meterShare,
} from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { type MenuItem, PopupMenu } from "../ui/Menu.tsx"
import styles from "./chat.module.css"

const RING = 16
const STROKE = 2.5
const RADIUS = (RING - STROKE) / 2
const LENGTH = 2 * Math.PI * RADIUS

/** The words of the reason why Compact is off (spec 003). */
export const compactOffKey = (off: CompactOff) => `chat.compact.off.${off}` as MessageKey

/**
 * The context meter in the chat header (spec 003, "Context meter"): a small ring with the numbers in
 * its label. A click opens Compact, or the reason why it is off. `canCompact` is false on a linked
 * server: a linked device sees the ring and never starts a compact (spec 012).
 */
export const ContextMeter = (props: {
  meter: ChatMeter
  compacting: boolean
  canCompact: boolean
  onCompact: () => void
}) => {
  const { t, locale } = useApp()
  const [position, setPosition] = createSignal<{ top: number; left: number }>()
  let trigger: HTMLButtonElement | undefined

  const share = () => meterShare(props.meter.used, props.meter.size)
  const number = (n: number) => new Intl.NumberFormat(locale()).format(n)
  const label = () => {
    const m = props.meter
    const s = share()
    if (m.size === null) return t("chat.meter.sizeUnknown")
    if (m.used === null || s === null) return t("chat.meter.unknown", { size: number(m.size) })
    return t("chat.meter.used", {
      used: number(m.used),
      size: number(m.size),
      percent: Math.round(s * 100),
    })
  }
  const items = (): MenuItem[] => {
    const off = props.meter.off
    const list: MenuItem[] = [{ label: label(), onSelect: () => {}, heading: true }]
    if (props.canCompact)
      list.push({
        label: t("chat.compact"),
        onSelect: props.onCompact,
        disabled: off !== null || props.compacting,
        testId: "compact",
        ...(off ? { reason: t(compactOffKey(off)) } : {}),
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
        data-used={props.meter.used ?? ""}
        data-size={props.meter.size ?? ""}
        data-off={props.meter.off ?? ""}
        data-level={compactDue(props.meter.used, props.meter.size) ? "high" : undefined}
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
            width={260}
            label={t("chat.meter")}
            testId="meter-menu"
            onClose={(refocus) => {
              setPosition(undefined)
              if (refocus) trigger?.focus()
            }}
          />
        )}
      </Show>
    </>
  )
}
