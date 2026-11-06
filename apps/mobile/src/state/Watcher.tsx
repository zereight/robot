import { useEffect } from "react"
import { AppState } from "react-native"
import { useApp } from "./context.tsx"

/** The work of the app that has no screen: the return from the background (spec 011). */
export const Watcher = () => {
  const { hub } = useApp()
  // Back from the background: connect again at once.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void hub.resume()
    })
    return () => subscription.remove()
  }, [hub])
  return null
}
