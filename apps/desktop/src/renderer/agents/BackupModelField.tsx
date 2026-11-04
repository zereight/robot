import { type AgentModel, catalogues, type MessageKey, sameModelChoice } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./agents.module.css"

/** The text of an effort level, or the level itself for one that the app has no word for. */
const effortWords = (level: string, t: (key: MessageKey) => string) => {
  const key = `model.effort.${level}`
  return key in catalogues.en ? t(key as MessageKey) : level
}

/**
 * The choice "Backup model" under "Model" in the form and the profile of an agent (spec 002, 006).
 * It starts as "None". The user picks an account, a model and an effort from the same lists as for
 * the main model. The form refuses the same account, model and effort as the main choice and says
 * why. A backup that is not ready on this computer (a synced backup whose account is missing or not
 * connected) shows as text with a muted line, so that an edit of another field cannot change it.
 */
export const BackupModelField = (props: {
  /** The main choice: the backup must differ from it. */
  main: AgentModel | null
  value: AgentModel | null
  onChange: (value: AgentModel | null) => void
  /** From the agent: false when its backup is not ready here (spec 006). Absent for a new agent. */
  ready?: boolean | undefined
}) => {
  const { t } = useApp()
  const providers = useProviders()
  const [choosing, setChoosing] = createSignal(false)
  const same = () => sameModelChoice(props.main, props.value)
  const shown = () => props.value !== null || choosing()
  const summary = () => {
    const value = props.value
    if (!value) return ""
    const account = providers.byId(value.accountId)?.name
    return [account, value.model, value.effort ? effortWords(value.effort, t) : null]
      .filter(Boolean)
      .join(" · ")
  }
  const remove = () => {
    setChoosing(false)
    props.onChange(null)
  }
  return (
    <div class={styles.field} data-testid="backup-field">
      <span class={styles.label}>{t("backup.label")}</span>
      <Show
        when={props.main}
        fallback={
          <span class={styles.hint} data-testid="backup-no-main">
            {t("backup.noMain")}
          </span>
        }
      >
        <div class={styles.backup}>
          <Show
            when={shown()}
            fallback={
              <div class={styles.backupSummary}>
                <span data-testid="backup-none">{t("backup.none")}</span>
                <Button onClick={() => setChoosing(true)} data-testid="backup-choose">
                  {t("backup.choose")}
                </Button>
              </div>
            }
          >
            <Show
              when={props.ready === false}
              fallback={
                <>
                  <ModelPicker value={props.value} onChange={props.onChange} />
                  <div>
                    <Button onClick={remove} data-testid="backup-remove">
                      {t("backup.remove")}
                    </Button>
                  </div>
                </>
              }
            >
              <div class={styles.backupSummary}>
                <span data-testid="backup-summary" data-user-data>
                  {summary()}
                </span>
                <Button onClick={remove} data-testid="backup-remove">
                  {t("backup.remove")}
                </Button>
              </div>
              <span class={styles.hint} data-testid="backup-not-ready">
                {t("backup.notReady")}
              </span>
            </Show>
          </Show>
          <Show when={same()}>
            <span class={styles.error} role="alert" data-testid="backup-same">
              {t("backup.same")}
            </span>
          </Show>
          <span class={styles.hint}>{t("backup.hint")}</span>
        </div>
      </Show>
    </div>
  )
}
