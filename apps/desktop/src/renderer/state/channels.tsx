import type { Channel } from "@robot/shared"
import {
  createContext,
  createEffect,
  createResource,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { call } from "../lib/rpc.ts"
import { useUi } from "./ui.tsx"

const createChannelsState = () => {
  const ui = useUi()
  const [store, setStore] = createStore<{ list: Channel[] }>({ list: [] })
  const [fetched, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("channels.list", { serverId }).catch(() => []),
  )
  createEffect(() => {
    const next = fetched()
    if (next) setStore("list", reconcile([...next], { key: "id" }))
  })
  const refresh = () => void refetch()
  onCleanup(window.robot.on("channels.changed", refresh))
  onCleanup(
    window.robot.on("places.changed", ({ serverId }) => serverId === ui.server()?.id && refresh()),
  )
  return {
    channels: () => store.list,
    byId: (id: string) => store.list.find((c) => c.id === id),
  }
}

export type ChannelsState = ReturnType<typeof createChannelsState>

const ChannelsContext = createContext<ChannelsState>()

export const ChannelsProvider = (props: ParentProps) => (
  <ChannelsContext.Provider value={createChannelsState()}>
    {props.children}
  </ChannelsContext.Provider>
)

export const useChannels = () => {
  const state = useContext(ChannelsContext)
  if (!state) throw new Error("useChannels needs ChannelsProvider")
  return state
}
