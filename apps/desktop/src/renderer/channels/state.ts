import type { ChannelMessage } from "@robot/shared"
import { createEffect, on, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { isForView, type ViewServer } from "../lib/events.ts"
import { placeMessage } from "../lib/order.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { linkEpoch } from "../state/link.ts"

/**
 * The messages of one channel, kept in step with the main process. `server` is the server that
 * the view shows (see `isForView`).
 */
export const createChannelChat = (
  channelId: string,
  server: () => ViewServer = () => undefined,
) => {
  const [state, setState] = createStore<{ loaded: boolean; messages: ChannelMessage[] }>({
    loaded: false,
    messages: [],
  })
  const load = () =>
    call("channels.history", { channelId })
      .then((messages) => {
        setState("messages", reconcile([...messages], { key: "id" }))
        setState("loaded", true)
      })
      // A linked server that is offline and has nothing saved: the view stays empty. One that
      // removed this device takes its messages from the view too (spec 012).
      .catch((error) => {
        if (error instanceof RpcFailure && error.error.code === "not_allowed")
          setState("messages", reconcile([], { key: "id" }))
        setState("loaded", true)
      })
  const offMessage = window.robot.on("channel.message", (message, from) => {
    if (message.channelId !== channelId || !isForView(server(), from)) return
    // A message that is there is updated field by field, so the row and the parts of a reply
    // that streams stay. A new message goes to the place that its time says.
    const index = state.messages.findIndex((m) => m.id === message.id)
    if (index >= 0) setState("messages", index, reconcile(message, { key: "id", merge: true }))
    else
      setState(
        "messages",
        produce((list) => placeMessage(list, message)),
      )
  })
  const offRemoved = window.robot.on("channel.removed", (event, from) => {
    if (event.channelId === channelId && isForView(server(), from))
      setState("messages", (list) => list.filter((m) => m.id !== event.messageId))
  })
  // The chips under a plan message change when a part changes, so the list loads again.
  let timer: ReturnType<typeof setTimeout> | undefined
  const offChanged = window.robot.on("channels.changed", (event) => {
    if (event.channelId !== channelId) return
    clearTimeout(timer)
    timer = setTimeout(() => void load(), 120)
  })
  onCleanup(() => {
    offMessage()
    offRemoved()
    offChanged()
    clearTimeout(timer)
  })
  void load()
  // A linked server that came back: read what happened while it was away.
  createEffect(on(linkEpoch.value, () => void load(), { defer: true }))
  return state
}
