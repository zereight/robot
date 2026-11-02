import type { PhoneHub, PhoneStorage } from "@robot/phone"
import { getLocales } from "expo-localization"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { useColorScheme } from "react-native"
import {
  errorText,
  type Locale,
  type MessageKey,
  type MessageParams,
  resolveLocale,
  translate,
} from "../i18n/index.ts"
import { type Prefs, writePrefs } from "../prefs.ts"
import { type Palette, palettes } from "../theme/palette.ts"

export interface AppValue {
  readonly hub: PhoneHub
  readonly storage: PhoneStorage
  readonly prefs: Prefs
  readonly setPrefs: (change: (prefs: Prefs) => Prefs) => void
  readonly locale: Locale
  readonly t: (key: MessageKey, params?: MessageParams) => string
  /** The plain line for an error of the link or of a request. */
  readonly errorLine: (error: unknown) => string
  readonly scheme: "dark" | "light"
  readonly palette: Palette
}

const AppContext = createContext<AppValue | null>(null)

export const AppProvider = (props: {
  readonly hub: PhoneHub
  readonly storage: PhoneStorage
  readonly initialPrefs: Prefs
  readonly children: ReactNode
}) => {
  const [prefs, setState] = useState(props.initialPrefs)
  const system = useColorScheme()
  const setPrefs = useCallback(
    (change: (prefs: Prefs) => Prefs) => {
      setState((old) => {
        const next = change(old)
        void writePrefs(props.storage, next)
        return next
      })
    },
    [props.storage],
  )
  const locale = resolveLocale(
    prefs.language,
    getLocales().map((l) => l.languageTag),
  )
  const scheme = prefs.theme === "system" ? (system === "light" ? "light" : "dark") : prefs.theme
  const value = useMemo<AppValue>(
    () => ({
      hub: props.hub,
      storage: props.storage,
      prefs,
      setPrefs,
      locale,
      t: (key, params) => translate(locale, key, params),
      errorLine: (error) => {
        const e = error as { code?: unknown; detail?: unknown } | null
        const code = typeof e?.code === "string" ? e.code : "internal"
        return errorText(locale, code, typeof e?.detail === "string" ? e.detail : "")
      },
      scheme,
      palette: palettes[scheme],
    }),
    [props.hub, props.storage, prefs, setPrefs, locale, scheme],
  )
  return <AppContext.Provider value={value}>{props.children}</AppContext.Provider>
}

export const useApp = (): AppValue => {
  const value = useContext(AppContext)
  if (!value) throw new Error("useApp needs AppProvider")
  return value
}

/** The state of all paired servers. The screen draws again when it changes. */
export const useHubState = () => {
  const { hub } = useApp()
  return useSyncExternalStore(
    (listener) => hub.subscribe(listener),
    () => hub.state(),
  )
}

/** One paired server, or undefined after unpair. */
export const useServer = (linkId: string) => {
  const state = useHubState()
  return state.servers.find((s) => s.link.id === linkId)
}
