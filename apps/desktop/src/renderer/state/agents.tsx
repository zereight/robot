import type { Agent } from "@robot/shared"
import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { call } from "../lib/rpc.ts"
import { useUi } from "./ui.tsx"

const createAgentsState = () => {
  const ui = useUi()
  const [store, setStore] = createStore<{ list: Agent[] }>({ list: [] })
  const [fetched, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("agents.list", { serverId, archived: false }).catch(() => []),
  )
  createEffect(() => {
    const next = fetched()
    if (next) setStore("list", reconcile([...next], { key: "id" }))
  })
  const agents = () => store.list
  const off = window.robot.on("agents.changed", ({ serverId }) => {
    if (serverId === "*" || serverId === ui.server()?.id) void refetch()
  })
  onCleanup(off)
  const byId = createMemo(() => new Map(agents().map((a) => [a.id, a])))
  return { agents, refetch, byId: (id: string) => byId().get(id) }
}

export type AgentsState = ReturnType<typeof createAgentsState>

const AgentsContext = createContext<AgentsState>()

export const AgentsProvider = (props: ParentProps) => (
  <AgentsContext.Provider value={createAgentsState()}>{props.children}</AgentsContext.Provider>
)

export const useAgents = () => {
  const state = useContext(AgentsContext)
  if (!state) throw new Error("useAgents needs AgentsProvider")
  return state
}
