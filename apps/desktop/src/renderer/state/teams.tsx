import { emptyTeamsView, type TeamsLinkView } from "@robot/shared"
import { createContext, createResource, onCleanup, type ParentProps, useContext } from "solid-js"
import { call } from "../lib/rpc.ts"

/**
 * The Teams link of this computer (spec 028), as the window sees it. The window of a linked device
 * never shows it: the link belongs to this computer.
 */
const createTeamsState = () => {
  const [view, { refetch }] = createResource(() => call("teams.get"), {
    initialValue: emptyTeamsView,
  })
  onCleanup(window.robot.on("teams.changed", () => void refetch()))
  return { view: (): TeamsLinkView => view() ?? emptyTeamsView }
}

export type TeamsState = ReturnType<typeof createTeamsState>

const TeamsContext = createContext<TeamsState>()

export const TeamsProvider = (props: ParentProps) => (
  <TeamsContext.Provider value={createTeamsState()}>{props.children}</TeamsContext.Provider>
)

export const useTeams = () => {
  const state = useContext(TeamsContext)
  if (!state) throw new Error("useTeams needs TeamsProvider")
  return state
}
