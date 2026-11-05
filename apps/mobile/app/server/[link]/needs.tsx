import type { WireNotice } from "@robot/link"
import { titleAfterName } from "@robot/phone"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { Pressable, type StyleProp, StyleSheet, Text, type TextStyle, View } from "react-native"
import { useApp, useServer } from "../../../src/state/context.tsx"
import { radius, space, text } from "../../../src/theme/palette.ts"
import { Body, Notice, Screen } from "../../../src/ui/kit.tsx"
import { ShownText, useShownName } from "../../../src/ui/names.tsx"

/**
 * Needs you (spec 011, Phone 1): the approval and question cards that wait on this server. A tap
 * opens the card in its conversation, where the user answers it.
 */
export default function NeedsYou() {
  const { link } = useLocalSearchParams<{ link: string }>()
  const { hub, t, palette } = useApp()
  const view = useServer(link)
  const shownName = useShownName(link)
  if (!view) return null
  const items = view.data.attention.filter(
    (n): n is WireNotice & { target: NonNullable<WireNotice["target"]> } =>
      (n.kind === "approval" || n.kind === "question") && n.target !== undefined,
  )
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
              <NoticeTitle
                notice={n}
                agentName={view.data.agents?.find((a) => a.id === n.agentId)?.name}
                shownName={shownName}
                style={[styles.title, { color: palette.text }]}
              />
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

/**
 * The title of a card is the name of the agent, and "· <computer>" when the request came from
 * another computer. The name shows with its organization prefix (spec 036, 011).
 */
const NoticeTitle = (props: {
  readonly notice: WireNotice
  readonly agentName: string | undefined
  readonly shownName: ReturnType<typeof useShownName>
  readonly style: StyleProp<TextStyle>
}) => {
  const rest = props.agentName ? titleAfterName(props.notice.title, props.agentName) : null
  if (rest === null || !props.notice.agentId)
    return (
      <Text numberOfLines={1} style={props.style}>
        {props.notice.title}
      </Text>
    )
  const shown = props.shownName(props.notice.agentId, props.agentName ?? "")
  return (
    <ShownText
      shown={{ ...shown, name: `${shown.name}${rest}` }}
      numberOfLines={1}
      style={props.style}
    />
  )
}

const styles = StyleSheet.create({
  item: { borderWidth: 1, borderRadius: radius.l, padding: space.m, gap: space.xs },
  top: { flexDirection: "row", alignItems: "center", gap: space.s },
  kind: { fontSize: text.xs, fontWeight: "700" },
  title: { flex: 1, fontSize: text.m, fontWeight: "600" },
  body: { fontSize: text.s, lineHeight: 19 },
})
