import * as Notifications from "expo-notifications"
import { router } from "expo-router"
import { useEffect, useRef } from "react"
import { AppState, Platform } from "react-native"
import { noticeContent, readNoticeData } from "../notices.ts"
import { forgetDownloads } from "../platform/files.ts"
import { useApp, useHubState } from "./context.tsx"

// Notifications show while the app runs (spec 011): the server pushes a notice, the phone shows it
// as a local notification. Nothing comes from a server of Expo or of anyone else.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

const openNotice = (data: unknown) => {
  const target = readNoticeData(data)
  if (!target) return
  router.push({
    pathname: "/server/[link]/[kind]/[id]",
    params: {
      link: target.linkId,
      kind: target.kind,
      id: target.id,
      ...(target.call ? { call: target.call } : {}),
    },
  })
}

/**
 * The work of the app that has no screen: notifications, the return from the background, and
 * the clean-up after a server removed this phone.
 */
export const Watcher = () => {
  const app = useApp()
  const { hub } = app
  const state = useHubState()
  // The listeners below live as long as the app; they read the newest settings from here.
  const current = useRef(app)
  current.current = app

  // A notice from a server becomes a local notification.
  useEffect(
    () =>
      hub.onNotice((linkId, notice) => {
        const { t, prefs } = current.current
        const content = noticeContent({
          t,
          prefs,
          linkId,
          serverName: hub.server(linkId)?.link.name ?? "",
          notice,
          active: AppState.currentState === "active",
        })
        if (!content) return
        void Notifications.scheduleNotificationAsync({
          content: { title: content.title, body: content.body, data: { ...content.data } },
          trigger: null,
        })
      }),
    [hub],
  )

  // A tap on a notification opens the card in its conversation (spec 011). A tap that started
  // the app is read once at the start.
  useEffect(() => {
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        openNotice(response.notification.request.content.data)
        void Notifications.clearLastNotificationResponseAsync()
      }
    })
    const subscription = Notifications.addNotificationResponseReceivedListener((response) =>
      openNotice(response.notification.request.content.data),
    )
    return () => subscription.remove()
  }, [])

  // Back from the background: connect again at once and read what was missed (spec 011).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void hub.resume()
      else if (next === "background") hub.pause()
    })
    return () => subscription.remove()
  }, [hub])

  // The system asks once for notifications, after the first pairing.
  const paired = state.servers.length > 0
  useEffect(() => {
    if (!paired) return
    void (async () => {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("default", {
          name: current.current.t("app.name"),
          importance: Notifications.AndroidImportance.HIGH,
        })
      }
      const now = await Notifications.getPermissionsAsync()
      if (now.status === "undetermined") await Notifications.requestPermissionsAsync()
    })()
  }, [paired])

  // A server that removed this phone: its downloaded files go with its cache.
  const removed = state.servers
    .filter((s) => s.state === "not_allowed")
    .map((s) => s.link.id)
    .join()
  useEffect(() => {
    for (const id of removed.split(",").filter(Boolean)) forgetDownloads(id)
  }, [removed])

  return null
}
