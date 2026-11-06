import type { DevicesState, JoinRequest } from "@robot/shared"
import {
  createContext,
  createResource,
  createSignal,
  onCleanup,
  type ParentProps,
  useContext,
} from "solid-js"
import { call } from "../lib/rpc.ts"

const createDevicesState = () => {
  const [state, { refetch }] = createResource(() => call("devices.get"))
  onCleanup(window.robot.on("devices.changed", () => void refetch()))

  // Devices that wait for Allow or Deny. The oldest one shows first.
  const [requests, setRequests] = createSignal<readonly JoinRequest[]>([])
  void call("devices.join.list").then(setRequests)
  onCleanup(
    window.robot.on("devices.join", ({ request, closed }) => {
      if (request) setRequests((list) => [...list.filter((r) => r.id !== request.id), request])
      if (closed) setRequests((list) => list.filter((r) => r.id !== closed))
    }),
  )

  return {
    /** The newest answer; it stays while a new one loads, so the page does not flicker. */
    state: () => state.latest,
    refetch,
    requests,
    decide: async (id: string, allow: boolean, canChange = false) => {
      setRequests((list) => list.filter((r) => r.id !== id))
      await call("devices.join.decide", { id, allow, canChange }).catch(() => {})
    },
  }
}

export type DevicesController = ReturnType<typeof createDevicesState>

const DevicesContext = createContext<DevicesController>()

export const DevicesProvider = (props: ParentProps) => (
  <DevicesContext.Provider value={createDevicesState()}>{props.children}</DevicesContext.Provider>
)

export const useDevices = () => {
  const state = useContext(DevicesContext)
  if (!state) throw new Error("useDevices needs DevicesProvider")
  return state
}

export type { DevicesState }
