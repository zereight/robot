import {
  type AppInfo,
  defaultSettings,
  type Locale,
  type MessageKey,
  type MessageParams,
  resolveLocale,
  type Settings,
  type SettingsPatch,
  translate,
} from "@robot/shared"
import { createContext, createMemo, createSignal, type ParentProps, useContext } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { call } from "../lib/rpc.ts"

export interface AppState {
  readonly info: AppInfo
  readonly settings: Settings
  readonly locale: () => Locale
  readonly t: (key: MessageKey, params?: MessageParams) => string
  update(patch: SettingsPatch): Promise<void>
}

const AppContext = createContext<AppState>()

/** Loads app info and settings before the first render. */
export const loadInitial = async () => {
  const [info, settings] = await Promise.all([call("app.info"), call("settings.get")])
  return { info, settings }
}

export const AppProvider = (props: ParentProps<{ info: AppInfo; settings: Settings }>) => {
  const [settings, setSettings] = createStore<Settings>({ ...defaultSettings, ...props.settings })
  const [systemLocale] = createSignal(props.info.systemLocale)
  window.robot.on("settings.changed", (next) => setSettings(reconcile(next)))

  const locale = createMemo(() => resolveLocale(settings.language, systemLocale()))
  const state: AppState = {
    info: props.info,
    settings,
    locale,
    t: (key, params) => translate(locale(), key, params),
    update: async (patch) => {
      setSettings(patch)
      try {
        setSettings(reconcile(await call("settings.update", patch)))
      } catch (error) {
        // The app refused the change (for example "Permission checks" before the decision model is
        // set up): the window shows the saved settings again, and the caller shows the reason.
        setSettings(reconcile(await call("settings.get")))
        throw error
      }
    },
  }
  return <AppContext.Provider value={state}>{props.children}</AppContext.Provider>
}

export const useApp = () => {
  const state = useContext(AppContext)
  if (!state) throw new Error("useApp needs AppProvider")
  return state
}
