import { badgeText, type TodaySnapshot } from "@robot/shared"
import { createContext, createMemo, onCleanup, type ParentProps, useContext } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { call } from "../lib/rpc.ts"
import { useUi } from "./ui.tsx"

const createTodayState = () => {
  const ui = useUi()
  const [store, setStore] = createStore<{ value: TodaySnapshot | undefined }>({ value: undefined })
  let pushed = false
  const apply = (next: TodaySnapshot) => setStore("value", reconcile(next, { key: "id" }))

  // The page is pushed whenever it changes, so the window never asks again. Listen first, then
  // read once: a page that was pushed meanwhile is newer than the read.
  onCleanup(
    window.robot.on("today.changed", (next) => {
      pushed = true
      apply(next)
    }),
  )
  void call("today.get")
    .then((first) => {
      if (!pushed) apply(first)
    })
    .catch(() => {})

  /** The count of items in "Needs you". The page of a linked server has none (spec 012). */
  const badge = createMemo(() => (ui.linked() ? 0 : (store.value?.badge ?? 0)))
  return {
    snapshot: () => store.value,
    badge,
    badgeText: () => badgeText(badge()),
  }
}

export type TodayState = ReturnType<typeof createTodayState>

const TodayContext = createContext<TodayState>()

export const TodayProvider = (props: ParentProps) => (
  <TodayContext.Provider value={createTodayState()}>{props.children}</TodayContext.Provider>
)

export const useToday = () => {
  const state = useContext(TodayContext)
  if (!state) throw new Error("useToday needs TodayProvider")
  return state
}
