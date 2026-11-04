import type { OrgChartPhase } from "@robot/phone"
import { useEffect, useRef, useState } from "react"
import { useApp } from "../state/context.tsx"

const OFF: OrgChartPhase = { kind: "off" }

/**
 * The org chart of one server for the screen (spec 029, "Phone"). The screen watches the server
 * while it is open: the hub asks for the ready model while the server is online, follows its
 * pushes, and drops the model when the server is not online. The model lives in this state only.
 * It is dropped when the screen closes and when another server opens, and it is never written to
 * disk.
 */
export const useOrgChart = (linkId: string) => {
  const { hub } = useApp()
  // The phase belongs to a server. A phase of another server never shows for this one.
  const [held, setHeld] = useState<{ readonly link: string; readonly phase: OrgChartPhase }>({
    link: linkId,
    phase: OFF,
  })
  const watch = useRef<{ readonly refresh: () => void } | null>(null)
  useEffect(() => {
    const own = hub.watchOrgChart(linkId, (phase) => setHeld({ link: linkId, phase }))
    watch.current = own
    return () => {
      own.stop()
      watch.current = null
    }
  }, [hub, linkId])
  return {
    phase: held.link === linkId ? held.phase : OFF,
    /** Asks the server again (pull to refresh, and "Try again"). */
    refresh: () => watch.current?.refresh(),
  }
}
