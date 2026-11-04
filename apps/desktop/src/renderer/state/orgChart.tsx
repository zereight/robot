import { buildChart, type ChartModel, type OrgSnapshot } from "@robot/shared"
import {
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js"
import { call } from "../lib/rpc.ts"

// The org chart of this computer (spec 029). The main process pushes the whole snapshot whenever
// it changes, so the window never asks twice. The chart is not cached: a window that starts
// reads it once.
const createOrgChartState = () => {
  const [snapshot, setSnapshot] = createSignal<OrgSnapshot>()
  let pushed = false
  // Listen first, then read once: a snapshot that was pushed meanwhile is newer than the read.
  onCleanup(
    window.robot.on("orgChart.changed", (next) => {
      pushed = true
      setSnapshot(next)
    }),
  )
  void call("orgChart.get")
    .then((first) => {
      if (!pushed) setSnapshot(first)
    })
    .catch(() => {})
  /** The nodes and lines of the chart, or undefined until the first snapshot came. */
  const model = createMemo<ChartModel | undefined>(() => {
    const next = snapshot()
    return next ? buildChart(next) : undefined
  })
  return { snapshot, model }
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
