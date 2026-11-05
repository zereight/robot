import type { MessageKey } from "@robot/shared"
import { setupRowProblem } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./agents.module.css"

/** One row of the setup editor. */
export interface SetupRow {
  name: string
  command: string
  onOwnCopy: boolean
  onTurnStart: boolean
}

/**
 * The dialog that adds or changes one setup action (spec 035). A name or a command that breaks
 * the limits blocks the save and says why. "Delete" drops the row from the draft; "Cancel" of
 * the editor still brings it back.
 */
export const SetupActionDialog = (props: {
  initial: SetupRow
  isNew: boolean
  onSave: (row: SetupRow) => void
  onDelete: (() => void) | undefined
  onClose: () => void
}) => {
  const { t } = useApp()
  const [name, setName] = createSignal(props.initial.name)
  const [command, setCommand] = createSignal(props.initial.command)
  const [onOwnCopy, setOnOwnCopy] = createSignal(props.initial.onOwnCopy)
  const [onTurnStart, setOnTurnStart] = createSignal(props.initial.onTurnStart)

  const draft = (): SetupRow => ({
    name: name(),
    command: command(),
    onOwnCopy: onOwnCopy(),
    onTurnStart: onTurnStart(),
  })
  const key = (): MessageKey | undefined => {
    const problem = setupRowProblem(draft())
    if (problem === "name") return "setup.invalid.name"
    if (problem === "command") return "setup.invalid.command"
    return undefined
  }

  return (
    <Dialog
      label={props.isNew ? t("setup.add") : t("setup.edit")}
      onClose={props.onClose}
      testId="setup-row-dialog"
    >
      <h2 class={styles.title}>{props.isNew ? t("setup.add") : t("setup.edit")}</h2>
      <div class={styles.setupField}>
        <label class={styles.setupLabel} for="setup-row-name">
          {t("setup.name")}
        </label>
        <input
          id="setup-row-name"
          class={styles.setupInput}
          value={name()}
          maxLength={80}
          autocomplete="off"
          spellcheck={false}
          aria-label={t("setup.name")}
          aria-invalid={key() === "setup.invalid.name"}
          onInput={(e) => setName(e.currentTarget.value)}
          data-testid="setup-name"
          autofocus
        />
      </div>
      <div class={styles.setupField}>
        <label class={styles.setupLabel} for="setup-row-command">
          {t("setup.command")}
        </label>
        <textarea
          id="setup-row-command"
          class={`${styles.setupInput} ${styles.setupCommand} ${styles.setupTextarea}`}
          value={command()}
          rows={3}
          maxLength={4000}
          autocomplete="off"
          spellcheck={false}
          aria-label={t("setup.command")}
          aria-invalid={key() === "setup.invalid.command"}
          onInput={(e) => setCommand(e.currentTarget.value)}
          data-testid="setup-command"
        />
      </div>
      <div class={styles.setupMarks}>
        <span class={styles.setupMark}>
          <Switch
            label={t("setup.mark.ownCopy")}
            testId="setup-mark-own-copy"
            checked={onOwnCopy()}
            onChange={setOnOwnCopy}
          />
          <span>{t("setup.mark.ownCopy")}</span>
        </span>
        <span class={styles.setupMark}>
          <Switch
            label={t("setup.mark.turn")}
            testId="setup-mark-turn"
            checked={onTurnStart()}
            onChange={setOnTurnStart}
          />
          <span>{t("setup.mark.turn")}</span>
        </span>
      </div>
      <Show when={key()}>
        {(reason) => (
          <div class={styles.setupError} role="alert" data-testid="setup-invalid">
            {t(reason())}
          </div>
        )}
      </Show>
      <div class={styles.setupFooter}>
        <Show when={props.onDelete}>
          {(remove) => (
            <Button variant="danger" onClick={() => remove()} data-testid="setup-row-delete">
              {t("setup.delete")}
            </Button>
          )}
        </Show>
        <Button onClick={props.onClose}>{t("setup.cancel")}</Button>
        <Button
          variant="primary"
          onClick={() => props.onSave(draft())}
          disabled={key() !== undefined}
          data-testid="setup-row-save"
        >
          {t("setup.save")}
        </Button>
      </div>
    </Dialog>
  )
}
