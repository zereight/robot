import {
  type MessageKey,
  PERMISSION_LEVELS,
  type PermissionLevel,
  type WorkflowDetail,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./graph.module.css"

/** The folder and the permission level of the workflow. Only the user changes them (spec 010). */
export const WorkflowSettings = (props: { workflow: WorkflowDetail }) => {
  const { t } = useApp()
  const [problem, setProblem] = createSignal<ErrorText>()
  const guard = (work: () => Promise<unknown>) => {
    setProblem(undefined)
    work().catch((e) => setProblem(describeError(e)))
  }
  return (
    <div class={styles.settings} data-testid="workflow-settings">
      <p class={styles.hintText}>{t("workflow.settings.hint")}</p>
      <div class={styles.field}>
        <span class={styles.fieldLabel}>{t("workflow.folder")}</span>
        <span class={styles.path} data-testid="workflow-folder">
          {props.workflow.folder}
        </span>
        <div>
          <Button
            onClick={() => guard(() => call("workflows.pickFolder", { id: props.workflow.id }))}
            data-testid="workflow-folder-pick"
          >
            {t("workflow.folder.pick")}
          </Button>
        </div>
      </div>
      <label class={styles.field}>
        <span class={styles.fieldLabel}>{t("workflow.permission")}</span>
        <select
          class={styles.control}
          data-testid="workflow-permission"
          value={props.workflow.permission}
          onChange={(e) =>
            guard(() =>
              call("workflows.setPermission", {
                id: props.workflow.id,
                level: e.currentTarget.value as PermissionLevel,
              }),
            )
          }
        >
          <For each={PERMISSION_LEVELS}>
            {(level) => (
              <option value={level} selected={props.workflow.permission === level}>
                {t(`permission.level.${level}` as MessageKey)}
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={problem()}>
        {(p) => (
          <p class={styles.errorText} role="alert">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>
    </div>
  )
}
