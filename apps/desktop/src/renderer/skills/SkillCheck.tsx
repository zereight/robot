import type { SkillFactResult } from "@robot/shared"
import { For, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { factKey, orderFacts, reasonText, statusKey } from "./skillCheck.ts"
import styles from "./skills.module.css"

/**
 * The result of the skill check (spec 017, "Skill check"): one line per fact, in the order of
 * `SKILL_FACTS`. The words say what the check saw. Closing changes nothing.
 */
export const SkillCheckLines = (props: { facts: readonly SkillFactResult[] }) => {
  const { t } = useApp()
  return (
    <ul class={styles.check} data-testid="skill-check">
      <For each={orderFacts(props.facts)}>
        {(line) => (
          <li
            class={styles.checkRow}
            data-testid="skill-check-fact"
            data-fact={line.id}
            data-status={line.status}
          >
            <span class={styles.checkName}>{t(factKey(line.id))}</span>
            <span class={styles.checkStatus}>{t(statusKey(line.status))}</span>
            <Show when={line.reason}>
              {(reason) => {
                const text = reasonText(reason())
                return <span class={styles.checkReason}>{t(text.key, text.params)}</span>
              }}
            </Show>
          </li>
        )}
      </For>
    </ul>
  )
}

/** The skill check of one skill, opened with "Check" on its row (spec 017, flow 11). */
export const SkillCheckDialog = (props: {
  name: string
  facts: readonly SkillFactResult[]
  onClose: () => void
}) => {
  const { t } = useApp()
  return (
    <Dialog label={t("skills.check.title")} onClose={props.onClose} testId="skill-check-dialog">
      <div class={styles.form} data-testid="skill-check-view">
        <h2 class={styles.title}>
          {t("skills.check.title")} · {props.name}
        </h2>
        <SkillCheckLines facts={props.facts} />
        <div class={styles.actions}>
          <Button variant="primary" onClick={props.onClose} data-testid="skill-check-close">
            {t("skills.check.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
