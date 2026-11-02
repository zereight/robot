import type {
  DevicesState,
  JoinRequest,
  SyncChangeEntry,
  SyncMode,
  SyncRequest,
  SyncStatus,
} from "@robot/shared"
import {
  createContext,
  createMemo,
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
  onCleanup(window.robot.on("servers.changed", () => void refetch()))

  // Devices that wait for Allow or Deny. The oldest one shows first.
  const [requests, setRequests] = createSignal<readonly JoinRequest[]>([])
  void call("devices.join.list").then(setRequests)
  onCleanup(
    window.robot.on("devices.join", ({ request, closed }) => {
      if (request) setRequests((list) => [...list.filter((r) => r.id !== request.id), request])
      if (closed) setRequests((list) => list.filter((r) => r.id !== closed))
    }),
  )

  // Sync between two computers (spec 016).
  const [syncList, { refetch: refetchSync }] = createResource(() => call("sync.list"))
  const [guard, { refetch: refetchGuard }] = createResource(() => call("sync.guard"))
  const [changes, { refetch: refetchChanges }] = createResource(() => call("sync.changes"))
  // The question keeps one identity while its numbers stay the same, so its dialog does not redraw.
  const guardNow = createMemo(() => guard.latest ?? null, null, {
    equals: (a, b) => a?.count === b?.count && a?.peerName === b?.peerName,
  })
  const refreshSync = () => {
    void refetchSync()
    void refetchGuard()
    void refetchChanges()
  }
  onCleanup(window.robot.on("sync.changed", refreshSync))
  onCleanup(window.robot.on("devices.changed", () => void refetchSync()))
  onCleanup(window.robot.on("servers.changed", () => void refetchSync()))
  const [syncRequests, setSyncRequests] = createSignal<readonly SyncRequest[]>([])
  void call("sync.requests").then(setSyncRequests)
  onCleanup(
    window.robot.on("sync.request", ({ request, closed }) => {
      if (request) setSyncRequests((list) => [...list.filter((r) => r.id !== request.id), request])
      if (closed) setSyncRequests((list) => list.filter((r) => r.id !== closed))
    }),
  )
  // A start that failed shows its error in the row of the computer.
  const [syncErrors, setSyncErrors] = createSignal<Readonly<Record<string, unknown>>>({})

  return {
    sync: {
      statuses: () => syncList.latest ?? ([] as readonly SyncStatus[]),
      of: (linkId: string): SyncStatus | undefined =>
        (syncList.latest ?? []).find((s) => s.linkId === linkId),
      /** The computer that is the sync pair, if any. */
      active: (): SyncStatus | undefined => (syncList.latest ?? []).find((s) => s.state !== "off"),
      /** The name of the computer that syncs with this one, once it has allowed the sync. */
      pairName: (): string | undefined => {
        const active = (syncList.latest ?? []).find(
          (s) => s.state !== "off" && s.state !== "offered",
        )
        return active ? state.latest?.servers.find((e) => e.id === active.linkId)?.name : undefined
      },
      /** True while the computer that syncs with this one is online. */
      pairOnline: (): boolean => {
        if (syncList.error) return true
        const state = (syncList.latest ?? []).find((s) => s.state !== "off")?.state
        return (
          state === "copying" || state === "live" || state === "paused" || state === "attention"
        )
      },
      requests: syncRequests,
      guard: guardNow,
      changes: (): readonly SyncChangeEntry[] => changes.latest ?? [],
      errors: syncErrors,
      clearError: (linkId: string) =>
        setSyncErrors((all) =>
          Object.fromEntries(Object.entries(all).filter(([k]) => k !== linkId)),
        ),
      start: async (linkId: string, mode: SyncMode) => {
        setSyncErrors((all) =>
          Object.fromEntries(Object.entries(all).filter(([k]) => k !== linkId)),
        )
        try {
          await call("sync.start", { linkId, mode })
        } catch (error) {
          setSyncErrors((all) => ({ ...all, [linkId]: error }))
        }
        refreshSync()
      },
      decide: async (id: string, allow: boolean) => {
        setSyncRequests((list) => list.filter((r) => r.id !== id))
        await call("sync.decide", { id, allow }).catch(() => {})
      },
    },
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
