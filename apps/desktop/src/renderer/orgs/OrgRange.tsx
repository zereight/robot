import {
  HAND_OFF_RANGES,
  type HandOffRange,
  handOffRangeUnder,
  type MessageKey,
  type Org,
} from "@robot/shared"
import { createResource, For, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import styles from "./orgs.module.css"

/**
 * The field "Hand-off range" of the form of an organization (spec 030, "Hand-off range"): four
 * values, "Inherit" first. Under "Inherit" a muted line says "Now: <value> from <organization>".
 * While the hand-off rule is "Any agent" the range has no effect, and a muted line says so. The
 * form owns the value, so it sends the value with its own Save. A linked computer without the
 * switch reads the field and changes nothing (spec 012).
 */
export const OrgRange = (props: {
  value: HandOffRange
  /** The parent that the form holds now: the line "Now" reads the range that it gives. */
  parentId: string | null
  /** The organizations of the server, to name the organization that holds the range. */
  orgs: readonly Org[]
  readOnly: boolean
  onChange: (value: HandOffRange) => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const serverId = () => (ui.serverOffline() ? undefined : ui.server()?.id)
  const [rule, { refetch }] = createResource(serverId, (id) =>
    call("organization.get", { serverId: id })
      .then((state) => state.handOff)
      .catch(() => undefined),
  )
  onCleanup(
    window.robot.on("organization.changed", (e) => {
      if (e.serverId === serverId()) void refetch()
    }),
  )

  const now = () => {
    const given = handOffRangeUnder(props.orgs, props.parentId)
    const value = t(`orgs.range.${given.value}` as MessageKey)
    const from = props.orgs.find((o) => o.id === given.from)?.name
    return from === undefined
      ? t("orgs.range.now.top", { value })
      : t("orgs.range.now", { value, organization: from })
  }

  return (
    <label class={styles.field} data-testid="org-range-field">
      <span class={styles.label}>{t("orgs.range")}</span>
      <select
        class={styles.input}
        disabled={props.readOnly}
        onChange={(e) => props.onChange(e.currentTarget.value as HandOffRange)}
        data-testid="org-range"
      >
        <For each={HAND_OFF_RANGES}>
          {(value) => (
            <option value={value} selected={props.value === value}>
              {t(`orgs.range.${value}` as MessageKey)}
            </option>
          )}
        </For>
      </select>
      <span class={styles.hint}>{t("orgs.range.hint")}</span>
      <Show when={props.value === "inherit"}>
        <span class={styles.hint} data-testid="org-range-now">
          {now()}
        </span>
      </Show>
      <Show when={rule() === "any"}>
        <span class={styles.hint} role="status" data-testid="org-range-any">
          {t("orgs.range.anyRule")}
        </span>
      </Show>
    </label>
  )
}
