import { dayBounds } from "@robot/shared"
import { createResource, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Switch } from "../ui/controls.tsx"
import styles from "./orgs.module.css"

/** A little after midnight, so a day that just began is counted. */
const MIDNIGHT_SLACK_MS = 1000

/**
 * The field "Daily token limit" of the form of an organization (spec 030, "Daily token limit"). It
 * is off by default. On, it takes a whole number from 10,000 to 100,000,000. Under it the muted
 * line "80% of the daily token limit is used." shows from 80% of the limit; at the limit the line
 * names the organization, as the reason of a blocked task does. The line reads the tokens again
 * when a task changes, and at midnight, when the day begins. The form owns the value, so it sends
 * the value with its own Save. A linked computer without the switch reads the field and changes
 * nothing (spec 012).
 */
export const OrgLimitField = (props: {
  /** The organization that exists, or undefined while the form makes a new one. */
  orgId: string | undefined
  orgName: string
  on: boolean
  text: string
  valid: boolean
  readOnly: boolean
  onSwitch: (on: boolean) => void
  onText: (text: string) => void
}) => {
  const { t } = useApp()
  const [view, { refetch }] = createResource(
    () => props.orgId,
    (id) => call("organizations.limit", { id }).catch(() => undefined),
  )
  // A task of any member counts, and a change of the organization changes the limit.
  onCleanup(window.robot.on("tasks.changed", () => void refetch()))
  onCleanup(window.robot.on("organizations.changed", () => void refetch()))
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(
      () => {
        void refetch()
        arm()
      },
      dayBounds(Date.now()).end - Date.now() + MIDNIGHT_SLACK_MS,
    )
  }
  arm()
  onCleanup(() => clearTimeout(timer))

  const line = () => {
    const state = view()?.state
    if (state === "near") return t("orgs.limit.near")
    if (state === "over") return t("error.org_limit", { detail: props.orgName })
    return ""
  }

  return (
    <div class={`${styles.field} ${styles.limitField}`} data-testid="org-daily-limit">
      <span class={styles.label}>{t("orgs.dailyLimit")}</span>
      <div class={styles.limitRow}>
        <Switch
          label={t("orgs.dailyLimit")}
          checked={props.on}
          disabled={props.readOnly}
          onChange={props.onSwitch}
          testId="org-limit-switch"
        />
        <Show when={props.on}>
          <input
            class={`${styles.input} ${styles.limitInput}`}
            inputmode="numeric"
            value={props.text}
            readOnly={props.readOnly}
            placeholder={t("orgs.dailyLimit.placeholder")}
            aria-label={t("orgs.dailyLimit")}
            aria-invalid={!props.valid}
            onInput={(e) => props.onText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.stopPropagation()
            }}
            data-testid="org-limit"
          />
        </Show>
      </div>
      <span class={styles.hint}>{t("orgs.dailyLimit.hint")}</span>
      <Show when={props.on && !props.valid}>
        <span class={styles.hint} role="alert" data-testid="org-limit-error">
          {t("error.invalid_daily_limit")}
        </span>
      </Show>
      <Show when={line()}>
        {(text) => (
          <span class={styles.hint} role="status" data-testid="org-limit-line">
            {text()}
          </span>
        )}
      </Show>
    </div>
  )
}
