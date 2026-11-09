import {
  type MessageKey,
  NOTE_NAME_CHARS,
  PERMISSION_LEVELS,
  type PermissionLevel,
  plainLine,
  type WorkflowDetail,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./graph.module.css"

/** The folder and the permission level of the workflow. Only the user changes them (spec 010). */
export const WorkflowSettings = (props: { workflow: WorkflowDetail }) => {
  const { t } = useApp()
  const [problem, setProblem] = createSignal<ErrorText>()
  const [notGit, setNotGit] = createSignal(false)
  const guard = (work: () => Promise<{ readonly folder: string; readonly permission: string }>) => {
    setProblem(undefined)
    setNotGit(false)
    const before = props.workflow
    work()
      .then((after) => {
        // A folder dialog that the user closes returns the workflow as it was.
        if (after.folder !== before.folder || after.permission !== before.permission)
          showToast("success", "workflows.saved")
      })
      .catch((e) => setProblem(describeError(e)))
  }
  // The switch "Work in a new worktree" (spec 007). A folder outside Git cannot turn it on: the
  // call fails with `worktree_not_git`, the switch stays off, and the muted line says so.
  const setWorktree = (on: boolean) => {
    setProblem(undefined)
    setNotGit(false)
    const before = props.workflow.newWorktree
    call("workflows.setNewWorktree", { id: props.workflow.id, on })
      .then((after) => {
        if (after.newWorktree !== before) showToast("success", "workflows.saved")
      })
      .catch((e) => {
        const text = describeError(e)
        if (text.key === "error.worktree_not_git") setNotGit(true)
        else setProblem(text)
      })
  }
  return (
    <div class={styles.settings} data-testid="workflow-settings">
      <p class={styles.hintText}>{t("workflow.settings.hint")}</p>
      <Show when={props.workflow.running}>
        <p class={styles.hintText} role="status" data-testid="workflow-settings-readonly">
          {t("graph.readonly")}
        </p>
      </Show>
      <div class={styles.field}>
        <span class={styles.fieldLabel}>{t("workflow.folder")}</span>
        <span class={styles.path} data-testid="workflow-folder">
          {props.workflow.folder}
        </span>
        <div>
          <Button
            disabled={props.workflow.running}
            onClick={() => guard(() => call("workflows.pickFolder", { id: props.workflow.id }))}
            data-testid="workflow-folder-pick"
          >
            {t("workflow.folder.pick")}
          </Button>
        </div>
        {/* The folder is shared with another workflow of the profile (spec 025, flow 1). It is
            not an error: the user can save. */}
        <Show when={(props.workflow.sharedWith ?? []).length > 0}>
          <p class={styles.hintText} data-testid="workflow-shared">
            {t("workflow.shared", {
              names: (props.workflow.sharedWith ?? [])
                .map((n) => plainLine(n, NOTE_NAME_CHARS))
                .join(", "),
            })}
          </p>
          <For each={props.workflow.claimless ?? []}>
            {(program) => (
              <p class={styles.hintText} data-testid="workflow-claimless">
                {t("workflow.claimless", { program })}
              </p>
            )}
          </For>
        </Show>
      </div>
      <div class={styles.field}>
        <span class={styles.fieldLabel}>{t("workflow.newWorktree")}</span>
        <div>
          <Switch
            label={t("workflow.newWorktree")}
            testId="workflow-new-worktree"
            checked={props.workflow.newWorktree}
            disabled={props.workflow.running}
            onChange={setWorktree}
          />
        </div>
        <Show when={notGit()}>
          <p class={styles.hintText} data-testid="workflow-new-worktree-not-git">
            {t("error.worktree_not_git")}
          </p>
        </Show>
      </div>
      <label class={styles.field}>
        <span class={styles.fieldLabel}>{t("workflow.permission")}</span>
        <select
          class={styles.control}
          data-testid="workflow-permission"
          disabled={props.workflow.running}
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
