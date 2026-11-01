import type { ProviderAccount } from "@robot/shared"
import { createContext, createResource, onCleanup, type ParentProps, useContext } from "solid-js"
import { call } from "../lib/rpc.ts"

const createProvidersState = () => {
  const [accounts, { refetch }] = createResource(() => call("providers.list"), {
    initialValue: [] as readonly ProviderAccount[],
  })
  onCleanup(window.robot.on("providers.changed", () => void refetch()))
  return { accounts, refetch, byId: (id: string) => accounts().find((a) => a.id === id) }
}

export type ProvidersState = ReturnType<typeof createProvidersState>

const ProvidersContext = createContext<ProvidersState>()

export const ProvidersProvider = (props: ParentProps) => (
  <ProvidersContext.Provider value={createProvidersState()}>
    {props.children}
  </ProvidersContext.Provider>
)

export const useProviders = () => {
  const state = useContext(ProvidersContext)
  if (!state) throw new Error("useProviders needs ProvidersProvider")
  return state
}
