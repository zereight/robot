import type { WorkflowOwner } from "@robot/shared"
import { For, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { setOpenTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { useOwnedWorkflows } from "../workflows/useOwner.ts"
import styles from "./orgs.module.css"

/**
 * The row "Workflows" of the form of an organization and of the profile of an agent (spec 010,
 * "Owner and participants"): the workflows that the owner owns. A click shows the workflow on the
 * Workflows page, as a click on a workflow of the Today page does, and closes the box that holds the
 * row. An owner with no workflow has no row.
 */
export const OwnedWorkflows = (props: {
  owner: WorkflowOwner
  /** The classes of the fieldset and its legend, so the row fits the box that holds it. */
  fieldClass: string | undefined
  legendClass: string | undefined
  testId: string
  itemTestId: string
  onOpen: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const owned = useOwnedWorkflows(() => props.owner)
  return (
    <Show when={owned().length > 0}>
      <fieldset class={props.fieldClass} data-testid={props.testId}>
        <legend class={props.legendClass}>{t("workflows.owner.row")}</legend>
        <div class={styles.profileRow}>
          <For each={owned()}>
            {(w) => (
              <button
                type="button"
                class={styles.chip}
                aria-label={t("workflows.owner.open", { name: w.name })}
                onClick={() => {
                  setOpenTarget({ kind: "workflow", id: w.id })
                  ui.selectPage("workflows")
                  props.onOpen()
                }}
                data-testid={props.itemTestId}
                data-user-data
              >
                {w.name}
              </button>
            )}
          </For>
        </div>
      </fieldset>
    </Show>
  )
}
