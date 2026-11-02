import { PhoneHub, type PhoneStorage } from "@robot/phone"
import { Stack } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useEffect, useState } from "react"
import { ActivityIndicator, View } from "react-native"
import {
  deriveW,
  fileStorage,
  secureRandom,
  secureSecrets,
  socketOpener,
} from "../src/platform/index.ts"
import { type Prefs, readPrefs } from "../src/prefs.ts"
import { AppProvider, useApp } from "../src/state/context.tsx"

interface Ready {
  readonly hub: PhoneHub
  readonly storage: PhoneStorage
  readonly prefs: Prefs
}

/** Opens the hub once: the identity from the secure store, the servers and their caches. */
const start = async (): Promise<Ready> => {
  const storage = fileStorage()
  const [prefs, hub] = await Promise.all([
    readPrefs(storage),
    PhoneHub.open({
      storage,
      secrets: secureSecrets,
      opener: socketOpener,
      random: secureRandom,
      deriveW,
    }),
  ])
  return { hub, storage, prefs }
}

const Screens = () => {
  const { t, palette, scheme } = useApp()
  return (
    <>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.background },
          headerTintColor: palette.accent,
          headerTitleStyle: { color: palette.text },
          contentStyle: { backgroundColor: palette.background },
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="index" options={{ title: t("servers.title") }} />
        <Stack.Screen name="welcome" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="pair" options={{ title: t("pair.title"), presentation: "modal" }} />
      </Stack>
    </>
  )
}

export default function RootLayout() {
  const [ready, setReady] = useState<Ready | null>(null)
  useEffect(() => {
    let live = true
    void start().then((r) => {
      if (live) setReady(r)
      else r.hub.close()
    })
    return () => {
      live = false
    }
  }, [])
  if (!ready) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#19191b",
        }}
      >
        <ActivityIndicator />
      </View>
    )
  }
  return (
    <AppProvider hub={ready.hub} storage={ready.storage} initialPrefs={ready.prefs}>
      <Screens />
    </AppProvider>
  )
}
