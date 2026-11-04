import type { LinkState } from "@robot/link"
import type { OrgChartPhase } from "@robot/phone"
import { buildOrgList, type OrgList } from "./list.ts"

// What the screen "Org chart" shows (spec 029, "Phone"; spec 011; spec 012). It follows the state
// of the link first: with the server in any state other than online, the screen shows the line
// "<server name> is offline." and no list, whatever the feed still holds. The chart is not cached
// on the phone, so a list never shows for a server that is not online.

export type OrgScreen =
  /** The server is not online: the line "<server name> is offline." and no list. */
  | { readonly kind: "offline" }
  /** The server is online and the model is on its way. */
  | { readonly kind: "loading" }
  /** An older server that does not know the request: the line "Open this on <server name>." */
  | { readonly kind: "unsupported" }
  /** The read failed while the server is online. The code names the failure. */
  | { readonly kind: "failed"; readonly code: string }
  /** No agent: the line "No agents yet." */
  | { readonly kind: "empty" }
  | { readonly kind: "list"; readonly list: OrgList }

export const orgScreen = (server: LinkState, phase: OrgChartPhase): OrgScreen => {
  if (server !== "online") return { kind: "offline" }
  switch (phase.kind) {
    case "off":
    case "loading":
      return { kind: "loading" }
    case "unsupported":
      return { kind: "unsupported" }
    case "failed":
      return { kind: "failed", code: phase.code }
    case "ready": {
      const list = buildOrgList(phase.model)
      return list.empty ? { kind: "empty" } : { kind: "list", list }
    }
  }
}
