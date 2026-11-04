import type { Channel, ChannelLimitInfo } from "@robot/shared"
import { dayBounds } from "@robot/shared"
import { createResource, onCleanup, Show } from "solid-js"
import chat from "../chat/chat.module.css"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"

/** A little after midnight, so a day that just began is counted. */
const MIDNIGHT_SLACK_MS = 1000

/**
 * The muted line of the daily token limit above the message box (spec 030). At 80% of the limit
 * of this channel it says "80% of the daily token limit is used." It makes no notification. When
 * a limit of this channel or of a higher channel is used, it says which channel's limit that is,
 * because the new work of the channel ends as Blocked (spec 005). The line reads the tokens again
 * when a task of the channel changes, and at midnight, when the day begins.
 */
export const LimitLine = (props: { channel: Channel }) => {
  const { t } = useApp()
  const [info, { refetch }] = createResource(
    () => props.channel.id,
    (channelId) => call("channels.limit", { channelId }).catch(() => undefined),
  )
  // A task of a lower channel counts for this channel, and a limit above may change: any change
  // of a channel reads the line again.
  onCleanup(window.robot.on("channels.changed", () => void refetch()))
  onCleanup(window.robot.on("tasks.changed", () => void refetch()))
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

  const line = (limit: ChannelLimitInfo) =>
    limit.stoppedBy
      ? t("channels.limit.over", { channel: limit.stoppedBy.name })
      : limit.state === "near"
        ? t("channels.limit.near")
        : ""

  return (
    <Show when={info()}>
      {(limit) => (
        <Show when={line(limit())}>
          {(text) => (
            <div class={chat.limitLine} role="status" data-testid="channel-limit-line">
              {text()}
            </div>
          )}
        </Show>
      )}
    </Show>
  )
}
