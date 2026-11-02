import { type ServerView, serverUnread } from "@robot/phone"
import { Redirect, router, Stack } from "expo-router"
import { Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { useApp, useHubState } from "../src/state/context.tsx"
import { radius, space, text } from "../src/theme/palette.ts"
import { Body, Button, HeaderButton, Notice, Screen, Title } from "../src/ui/kit.tsx"
import { stateText, stateTone } from "../src/ui/states.ts"

/** Servers (spec 011): each paired computer, its connection state and its unread count. */
export default function Servers() {
  const { t } = useApp()
  const state = useHubState()
  if (state.deviceName === null) return <Redirect href="/welcome" />
  const servers = state.servers
  // On iPhone a "no" to the local network question leaves the computer unreachable. The phone
  // cannot read that answer, so the line shows while a server cannot be reached.
  const unreachable = Platform.OS === "ios" && servers.some((s) => s.state === "offline")

  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <HeaderButton
              testID="servers.settings"
              label={t("servers.settings")}
              onPress={() => router.push("/settings")}
            />
          ),
          headerRight: () => (
            <HeaderButton
              testID="servers.add"
              label={t("servers.add")}
              onPress={() => router.push("/pair")}
            />
          ),
        }}
      />
      <Screen testID="servers">
        {servers.length === 0 ? (
          <View style={styles.empty}>
            <Title>{t("servers.empty.title")}</Title>
            <Body muted>{t("servers.empty.body")}</Body>
            <Button label={t("servers.add")} onPress={() => router.push("/pair")} />
          </View>
        ) : (
          servers.map((view) => <ServerRow key={view.link.id} view={view} />)
        )}
        {unreachable ? <Notice text={t("servers.localNetwork")} /> : null}
      </Screen>
    </>
  )
}

const ServerRow = ({ view }: { readonly view: ServerView }) => {
  const { t, palette } = useApp()
  const unread = serverUnread(view.data.places)
  const tone = stateTone(view.state)
  const dot =
    tone === "good"
      ? palette.success
      : tone === "bad"
        ? palette.danger
        : tone === "busy"
          ? palette.accent
          : palette.textMuted
  const line = stateText(t, view)
  return (
    <Pressable
      testID={`server.${view.link.name}`}
      accessibilityRole="button"
      accessibilityLabel={t("servers.row", { name: view.link.name, state: line })}
      onPress={() => router.push({ pathname: "/server/[link]", params: { link: view.link.id } })}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? palette.pressed : palette.surface,
          borderColor: palette.border,
        },
      ]}
    >
      <View style={styles.rowTop}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>
          {view.link.name}
        </Text>
        {unread > 0 ? (
          <View style={[styles.badge, { backgroundColor: palette.accent }]}>
            <Text
              style={[styles.badgeText, { color: palette.accentText }]}
              accessibilityLabel={t("servers.unread", { count: unread })}
            >
              {unread > 99 ? "99+" : unread}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.state, { color: tone === "bad" ? palette.danger : palette.textMuted }]}>
        {line}
      </Text>
      {view.state === "not_allowed" ? (
        <Button
          testID={`server.${view.link.name}.pairAgain`}
          kind="secondary"
          label={t("servers.pairAgain")}
          onPress={() => router.push("/pair")}
        />
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  empty: { gap: space.m, paddingTop: space.xl },
  row: { borderRadius: radius.l, borderWidth: 1, padding: space.l, gap: space.s },
  rowTop: { flexDirection: "row", alignItems: "center", gap: space.s },
  dot: { width: 10, height: 10, borderRadius: 5 },
  name: { flex: 1, fontSize: text.l, fontWeight: "600" },
  state: { fontSize: text.s },
  badge: {
    minWidth: 24,
    height: 24,
    borderRadius: radius.round,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: text.xs, fontWeight: "700" },
})
