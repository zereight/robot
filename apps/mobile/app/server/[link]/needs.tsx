import { router, Stack, useLocalSearchParams } from "expo-router"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { waitingCards } from "../../../src/notices.ts"
import { useApp, useServer } from "../../../src/state/context.tsx"
import { radius, space, text } from "../../../src/theme/palette.ts"
import { Body, Notice, Screen } from "../../../src/ui/kit.tsx"

/**
 * Needs you (spec 011, Phone 1): the approval and question cards of agents that wait on this
 * server. A tap opens the card in the chat of the agent, where the user answers it.
 */
export default function NeedsYou() {
  const { link } = useLocalSearchParams<{ link: string }>()
  const { hub, t, palette } = useApp()
  const view = useServer(link)
  if (!view) return null
  const items = waitingCards(view.data.attention)
  return (
    <>
      <Stack.Screen options={{ title: t("needs.title") }} />
      <Screen testID="needs" onRefresh={() => hub.refresh(link)}>
        {view.state !== "online" ? (
          <Notice text={t("needs.offline", { name: view.link.name })} />
        ) : items.length === 0 ? (
          <Body muted>{t("needs.empty", { name: view.link.name })}</Body>
        ) : null}
        {items.map((n) => (
          <Pressable
            key={`${n.agentId}:${n.callId}`}
            testID={`needs.${n.kind}`}
            accessibilityRole="button"
            accessibilityHint={t("needs.open")}
            onPress={() =>
              router.push({
                pathname: "/server/[link]/[kind]/[id]",
                params: {
                  link,
                  kind: n.target.kind,
                  id: n.target.id,
                  ...(n.callId ? { call: n.callId } : {}),
                },
              })
            }
            style={({ pressed }) => [
              styles.item,
              {
                borderColor: palette.border,
                backgroundColor: pressed ? palette.pressed : palette.surface,
              },
            ]}
          >
            <View style={styles.top}>
              <Text style={[styles.kind, { color: palette.accent }]}>
                {n.kind === "approval" ? t("needs.approval") : t("needs.question")}
              </Text>
              <Text numberOfLines={1} style={[styles.title, { color: palette.text }]}>
                {n.title}
              </Text>
            </View>
            <Text numberOfLines={3} style={[styles.body, { color: palette.textMuted }]}>
              {n.body}
            </Text>
          </Pressable>
        ))}
      </Screen>
    </>
  )
}

const styles = StyleSheet.create({
  item: { borderWidth: 1, borderRadius: radius.l, padding: space.m, gap: space.xs },
  top: { flexDirection: "row", alignItems: "center", gap: space.s },
  kind: { fontSize: text.xs, fontWeight: "700" },
  title: { flex: 1, fontSize: text.m, fontWeight: "600" },
  body: { fontSize: text.s, lineHeight: 19 },
})
