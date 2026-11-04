import { buildChart, type ChartModel, type OrgSnapshot } from "@robot/shared"
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js"
import { isForView } from "../lib/events.ts"
import { call } from "../lib/rpc.ts"
import { NewestModel, orgSource, unsupportedByServer } from "../orgchart/source.ts"
import { linkEpoch } from "./link.ts"
import { useUi } from "./ui.tsx"

// The org chart (spec 029). On this computer the main process pushes the whole snapshot whenever
// it changes, so the window never asks twice. The chart is not cached: a window that starts
// reads it once.
//
// A linked server (spec 012) sends a ready model instead, and pushes it whenever it changes. The
// window asks for it only while the page is open and the server is online, and it keeps it in
// memory only: it is dropped when the page closes, when another server opens and when the server
// is not online. Nothing of it is written to disk.
const createOrgChartState = () => {
  const ui = useUi()
  const [snapshot, setSnapshot] = createSignal<OrgSnapshot>()
  let pushed = false
  // Listen first, then read once: a snapshot that was pushed meanwhile is newer than the read.
  onCleanup(
    window.robot.on("orgChart.changed", (next, from) => {
      // A snapshot from a linked server is not the chart of this computer.
      if (from !== undefined) return
      pushed = true
      setSnapshot(next)
    }),
  )
  void call("orgChart.get")
    .then((first) => {
      if (!pushed) setSnapshot(first)
    })
    .catch(() => {})
  /** The nodes and lines of the chart of this computer, or undefined until the snapshot came. */
  const local = createMemo<ChartModel | undefined>(() => {
    const next = snapshot()
    return next ? buildChart(next) : undefined
  })

  // ---------------------------------------------------------------- A linked server
  const source = createMemo(() => orgSource(ui.server()))
  const [linked, setLinked] = createSignal<ChartModel>()
  /** True when the server answers "Not allowed": it is a build that has no org chart request. */
  const [unsupported, setUnsupported] = createSignal(false)
  const feed = new NewestModel<ChartModel>(setLinked)
  /** The linked server whose chart is wanted now: the page is open and the server is online. */
  const wanted = createMemo(() =>
    source() === "linked" && ui.ui.page === "orgchart" ? ui.server()?.id : undefined,
  )
  onCleanup(
    window.robot.on("orgChart.model", (next, from) => {
      const id = wanted()
      if (id && isForView(id, from)) feed.pushed(next)
    }),
  )
  // A server that comes back online is asked again: the pushes of the time away were not seen.
  createEffect(
    on([wanted, linkEpoch.value], ([serverId]) => {
      setUnsupported(false)
      if (!serverId) {
        feed.stop()
        return
      }
      const question = feed.begin()
      call("orgChart.model", { serverId })
        .then((model) => void feed.answered(question, model))
        .catch((error) => {
          if (!feed.current(question)) return
          // A server that did not know the request answers "Not allowed" (spec 012, "Messages").
          if (unsupportedByServer(error)) setUnsupported(true)
        })
    }),
  )

  /** What the page draws now, or undefined: nothing is drawn while the server is not online. */
  const model = createMemo<ChartModel | undefined>(() => {
    const from = source()
    return from === "local" ? local() : from === "linked" ? linked() : undefined
  })
  return { snapshot, model, source, unsupported }
}

export type OrgChartState = ReturnType<typeof createOrgChartState>

const OrgChartContext = createContext<OrgChartState>()

export const OrgChartProvider = (props: ParentProps) => (
  <OrgChartContext.Provider value={createOrgChartState()}>
    {props.children}
  </OrgChartContext.Provider>
)

export const useOrgChart = () => {
  const state = useContext(OrgChartContext)
  if (!state) throw new Error("useOrgChart needs OrgChartProvider")
  return state
}
