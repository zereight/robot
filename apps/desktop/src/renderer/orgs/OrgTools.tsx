import { type OrgToolRow, orgToolSwitch } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Segmented } from "../ui/controls.tsx"
import styles from "./orgs.module.css"

/**
 * The part "Tools" of the form of an organization (spec 030, "Access"): the skills and the
 * connections of this computer, each with the value "Inherit" or "On". The value is the list "the
 * agents that may use it" of the skill or the connection, so a change counts from the next turn.
 * A linked computer reads the rows and has no control (spec 012). "Off" comes with a later step.
 */
export const OrgToolsPart = (props: { orgId: string }) => {
  const { t } = useApp()
  const ui = useUi()
  const [rows, { mutate, refetch }] = createResource(
    () => props.orgId,
    (orgId) => call("orgTools.list", { orgId }).catch(() => [] as OrgToolRow[]),
  )
  const [error, setError] = createSignal<ErrorText>()
  onCleanup(window.robot.on("skills.changed", () => void refetch()))
  onCleanup(window.robot.on("connections.changed", () => void refetch()))

  const set = async (row: OrgToolRow, choice: "on" | "inherit") => {
    setError(undefined)
    try {
      mutate(await call("orgTools.set", { orgId: props.orgId, kind: row.kind, id: row.id, choice }))
    } catch (e) {
      setError(describeError(e))
    }
  }

  const group = (kind: OrgToolRow["kind"]) => (rows() ?? []).filter((row) => row.kind === kind)

  const section = (kind: OrgToolRow["kind"], title: string) => (
    <Show when={group(kind).length > 0}>
      <div class={styles.toolGroup} data-testid={`org-tools-${kind}s`}>
        <span class={styles.hint}>{title}</span>
        <For each={group(kind)}>
          {(row) => {
            const state = () => orgToolSwitch(row, ui.linked())
            return (
              <div class={styles.toolRow} data-testid="org-tool-row" data-name={row.name}>
                <span class={styles.toolName}>{row.name}</span>
                <Show when={row.all}>
                  <span class={styles.hint} data-testid="org-tool-all">
                    {t("orgs.tools.all")}
                  </span>
                </Show>
                <Segmented
                  label={row.name}
                  testId="org-tool-value"
                  value={state().value}
                  onChange={(value) => {
                    if (value === "on" || value === "inherit") void set(row, value)
                  }}
                  options={[
                    {
                      value: "inherit",
                      label: t("orgs.tools.inherit"),
                      disabled: state().disabled,
                    },
                    { value: "on", label: t("orgs.tools.on"), disabled: state().disabled },
                  ]}
                />
              </div>
            )
          }}
        </For>
      </div>
    </Show>
  )

  return (
    <fieldset class={styles.field} data-testid="org-tools">
      <legend class={styles.label}>{t("orgs.tools")}</legend>
      <span class={styles.hint}>{t("orgs.tools.hint")}</span>
      <Show when={ui.linked()}>
        <span class={styles.hint} data-testid="org-tools-linked">
          {t("orgs.tools.linked", { name: ui.server()?.name ?? "" })}
        </span>
      </Show>
      <Show
        when={(rows() ?? []).length > 0}
        fallback={
          <span class={styles.hint} data-testid="org-tools-empty">
            {t("orgs.tools.empty")}
          </span>
        }
      >
        {section("skill", t("orgs.tools.skills"))}
        {section("connection", t("orgs.tools.connections"))}
      </Show>
      <Show when={error()}>
        {(err) => (
          <span class={styles.error} role="alert" data-testid="org-tools-error">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
    </fieldset>
  )
}
