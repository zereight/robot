import type { ChannelToolRow } from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Switch } from "../ui/controls.tsx"
import styles from "./channels.module.css"
import { switchOf, toolsOfKind } from "./toolsView.ts"

/**
 * The part "Tools of this channel" of the channel settings (spec 030): the skills and the
 * connections of this computer, each with a switch. A switch on gives the skill or connection to
 * each member of the channel and of its lower channels. The switch is the list "the agents that may
 * use it" of the skill or the connection, so a change counts from the next turn. A linked device
 * reads the rows and has no control (spec 012).
 */
export const ChannelToolsPart = (props: { channelId: string }) => {
  const { t } = useApp()
  const ui = useUi()
  const [rows, { mutate, refetch }] = createResource(
    () => props.channelId,
    (channelId) => call("channelTools.list", { channelId }).catch(() => [] as ChannelToolRow[]),
  )
  const [error, setError] = createSignal<ErrorText>()
  onCleanup(window.robot.on("skills.changed", () => void refetch()))
  onCleanup(window.robot.on("connections.changed", () => void refetch()))

  const toggle = async (row: ChannelToolRow, on: boolean) => {
    setError(undefined)
    try {
      mutate(
        await call("channelTools.set", {
          channelId: props.channelId,
          kind: row.kind,
          id: row.id,
          on,
        }),
      )
    } catch (e) {
      setError(describeError(e))
    }
  }

  const group = (kind: ChannelToolRow["kind"]) => toolsOfKind(rows() ?? [], kind)

  const section = (kind: ChannelToolRow["kind"], title: string) => (
    <Show when={group(kind).length > 0}>
      <div class={styles.toolGroup} data-testid={`channel-tools-${kind}s`}>
        <span class={styles.hint}>{title}</span>
        <For each={group(kind)}>
          {(row) => (
            <div class={styles.toolRow} data-testid="channel-tool-row" data-name={row.name}>
              <span class={styles.toolName}>{row.name}</span>
              <Show when={row.all}>
                <span class={styles.hint} data-testid="channel-tool-all">
                  {t("channels.tools.all")}
                </span>
              </Show>
              <Switch
                label={row.name}
                checked={switchOf(row, ui.linked()).checked}
                disabled={switchOf(row, ui.linked()).disabled}
                onChange={(on) => void toggle(row, on)}
                testId="channel-tool-switch"
              />
            </div>
          )}
        </For>
      </div>
    </Show>
  )

  return (
    <fieldset class={styles.field} data-testid="channel-tools">
      <legend class={styles.label}>{t("channels.tools")}</legend>
      <span class={styles.hint}>{t("channels.tools.hint")}</span>
      <Show when={ui.linked()}>
        <span class={styles.hint} data-testid="channel-tools-linked">
          {t("channels.tools.linked", { name: ui.server()?.name ?? "" })}
        </span>
      </Show>
      <Show
        when={(rows() ?? []).length > 0}
        fallback={
          <span class={styles.hint} data-testid="channel-tools-empty">
            {t("channels.tools.empty")}
          </span>
        }
      >
        {section("skill", t("channels.tools.skills"))}
        {section("connection", t("channels.tools.connections"))}
      </Show>
      <Show when={error()}>
        {(err) => (
          <span class={styles.hint} role="alert" data-testid="channel-tools-error">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
    </fieldset>
  )
}
