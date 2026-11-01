import type { ChannelMessage } from "@robot/shared"
import { onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { call } from "../lib/rpc.ts"

/** The messages of one channel, kept in step with the main process. */
export const createChannelChat = (channelId: string) => {
  const [state, setState] = createStore<{ loaded: boolean; messages: ChannelMessage[] }>({
    loaded: false,
    messages: [],
  })
  const load = () =>
    call("channels.history", { channelId }).then((messages) => {
      setState("messages", reconcile([...messages], { key: "id" }))
      setState("loaded", true)
    })
  const offMessage = window.robot.on("channel.message", (message) => {
    if (message.channelId !== channelId) return
    setState(
      "messages",
      produce((list) => {
        const index = list.findIndex((m) => m.id === message.id)
        if (index >= 0) list[index] = message
        else list.push(message)
      }),
    )
  })
  const offRemoved = window.robot.on("channel.removed", (event) => {
    if (event.channelId === channelId)
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
  return state
}
