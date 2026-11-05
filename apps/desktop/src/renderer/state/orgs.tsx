import {
  deepestOrgIndex,
  type Org,
  orgParent,
  orgsOfAgent,
  type ShownName,
  shownName,
} from "@robot/shared"
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
import { useApp } from "./app.tsx"
import { useUi } from "./ui.tsx"

/**
 * The organizations of one server (spec 030). On a linked server they come over the link (spec
 * 012): a read needs the link only. The list is by name, ignoring case. The provider below reads
 * the server on screen; a list that names agents of another server (the archive list, which is
 * always the local server) makes its own with that server.
 */
export const createOrgs = (serverId: () => string | undefined) => {
  const app = useApp()
  const [store, setStore] = createStore<{ list: Org[] }>({ list: [] })
  // An offline linked server answers nothing: the last list stays on screen, and the form says
  // that the server is offline.
  const [fetched, { refetch }] = createResource(serverId, (id) =>
    call("organizations.list", { serverId: id }).catch(() => undefined),
  )
  createEffect(() => {
    const next = fetched()
    if (next) setStore("list", reconcile([...next], { key: "id" }))
  })
  // A change of the server drops the old list at once.
  createEffect(() => {
    void serverId()
    setStore("list", reconcile([], { key: "id" }))
  })
  onCleanup(
    window.robot.on("organizations.changed", ({ serverId: changed }) => {
      if (changed === serverId()) void refetch()
    }),
  )
  const orgs = () => store.list
  // The deepest organization of each agent (spec 036). One decision in one place: every label of an
  // agent reads it. It follows the list, so a rename or a new member shows at once.
  const deepest = createMemo(() => deepestOrgIndex(store.list))
  /**
   * The whole name of the organization that the prefix of an agent shows, or null when the agent is
   * in none or when the switch "Show the organization before an agent name" is off. A search of
   * names reads it too, so with the switch off the organization never matches (spec 036).
   */
  const prefixOrg = (agentId: string): string | null =>
    app.settings.showOrgPrefix ? (deepest().get(agentId)?.name ?? null) : null
  return {
    orgs,
    /** The deepest organization of an agent, or undefined. It does not follow the prefix switch. */
    deepestOf: (agentId: string) => deepest().get(agentId),
    byId: (id: string) => store.list.find((o) => o.id === id),
    /** The organizations that an agent is a member of, by name. */
    ofAgent: (agentId: string) => orgsOfAgent(store.list, agentId),
    prefixOrg,
    /** The name of an agent as the window shows it: the prefix, the note and the accessible name. */
    shown: (agentId: string, name: string): ShownName => shownName(name, prefixOrg(agentId), true),
    /** The parent as the tree reads it now: a stored parent that breaks a rule counts as none. */
    parentOf: (id: string) => orgParent(store.list, id),
    refetch,
  }
}

export type OrgsState = ReturnType<typeof createOrgs>

const OrgsContext = createContext<OrgsState>()

export const OrgsProvider = (props: ParentProps) => {
  const ui = useUi()
  return (
    <OrgsContext.Provider value={createOrgs(() => ui.server()?.id)}>
      {props.children}
    </OrgsContext.Provider>
  )
}

export const useOrgs = () => {
  const state = useContext(OrgsContext)
  if (!state) throw new Error("useOrgs needs OrgsProvider")
  return state
}
