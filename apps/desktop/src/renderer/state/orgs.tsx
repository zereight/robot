import { type Org, orgParent, orgsOfAgent } from "@robot/shared"
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

/**
 * The organizations of the server on screen (spec 030). On a linked server they come over the link
 * (spec 012): a read needs the link only. The list is by name, ignoring case.
 */
const createOrgsState = () => {
  const ui = useUi()
  const [store, setStore] = createStore<{ list: Org[] }>({ list: [] })
  // An offline linked server answers nothing: the last list stays on screen, and the form says
  // that the server is offline.
  const [fetched, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("organizations.list", { serverId }).catch(() => undefined),
  )
  createEffect(() => {
    const next = fetched()
    if (next) setStore("list", reconcile([...next], { key: "id" }))
  })
  // A change of the server on screen drops the old list at once.
  createEffect(() => {
    void ui.server()?.id
    setStore("list", reconcile([], { key: "id" }))
  })
  onCleanup(
    window.robot.on("organizations.changed", ({ serverId }) => {
      if (serverId === ui.server()?.id) void refetch()
    }),
  )
  const orgs = () => store.list
  return {
    orgs,
    byId: (id: string) => store.list.find((o) => o.id === id),
    /** The organizations that an agent is a member of, by name. */
    ofAgent: (agentId: string) => orgsOfAgent(store.list, agentId),
    /** The parent as the tree reads it now: a stored parent that breaks a rule counts as none. */
    parentOf: (id: string) => orgParent(store.list, id),
    refetch,
  }
}

export type OrgsState = ReturnType<typeof createOrgsState>

const OrgsContext = createContext<OrgsState>()

export const OrgsProvider = (props: ParentProps) => (
  <OrgsContext.Provider value={createOrgsState()}>{props.children}</OrgsContext.Provider>
)

export const useOrgs = () => {
  const state = useContext(OrgsContext)
  if (!state) throw new Error("useOrgs needs OrgsProvider")
  return state
}
