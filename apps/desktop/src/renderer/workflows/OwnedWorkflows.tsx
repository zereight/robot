import type { WorkflowOwner } from "@robot/shared"
import { For, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { setOpenTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { useOwnedWorkflows } from "./useOwner.ts"
import styles from "./workflows.module.css"

/**
 * The row "Workflows" of the profile of an agent (spec 002, spec 010, "Owner and participants"): the
 * workflows that the agent owns. A click shows the workflow on the Workflows page and closes the box
 * that holds the row. An agent with no workflow has no row.
 */
export const OwnedWorkflows = (props: {
  owner: WorkflowOwner
  /** The class of the legend, so the row fits the box that holds it. */
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
      <fieldset class={styles.ownedField} data-testid={props.testId}>
        <legend class={props.legendClass}>{t("workflows.owner.row")}</legend>
        <div class={styles.ownedRow}>
          <For each={owned()}>
            {(w) => (
              <button
                type="button"
                class={styles.ownedChip}
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
