import { connectionToolLabel, type MessagePart } from "@robot/shared"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { useApp } from "../state/context.tsx"
import { radius, space, text } from "../theme/palette.ts"
import { Sheet } from "../ui/Sheet.tsx"

type Tool = Extract<MessagePart, { kind: "tool" }>

/** A plain sign for the kind of step: a file, a command, a web page, or another tool. */
export const toolIcon = (name: string) =>
  /file|write|edit|read|list/.test(name)
    ? "▤"
    : /command|shell|run/.test(name)
      ? "›_"
      : /url|fetch|web|browser|page/.test(name)
        ? "◎"
        : "◇"

/** A compact card for one step of the agent (spec 003). A tap shows the details. */
export const ToolCard = ({ tool }: { readonly tool: Tool }) => {
  const { t, palette } = useApp()
  const [open, setOpen] = useState(false)
  const state = tool.refused
    ? t(
        tool.refused === "rule"
          ? "tool.refusedRule"
          : tool.refused === "address"
            ? "tool.refusedAddress"
            : "tool.refused",
      )
    : tool.state === "running"
      ? t("tool.running")
      : tool.state === "waiting"
        ? t("tool.waiting")
        : tool.state === "failed"
          ? t("tool.failed")
          : t("tool.done")
  const tone =
    tool.state === "failed" || tool.refused
      ? palette.danger
      : tool.state === "waiting"
        ? palette.accent
        : palette.textMuted
  // A call of a connection tool names the connection and the tool; a search of tools names its
  // words and what it found (spec 018).
  const label =
    tool.connection?.kind === "call"
      ? connectionToolLabel(tool.connection.connection, tool.connection.tool)
      : tool.connection?.kind === "search"
        ? t("tool.searchTools", { words: tool.connection.words, found: tool.connection.found })
        : tool.label || tool.name
  const decision = tool.decision
    ? t(tool.decision.answer === "allow" ? "tool.allowedBy" : "tool.deniedBy", {
        name: tool.decision.by,
      })
    : null
  return (
    <>
      <Pressable
        testID={`tool.${tool.name}`}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${state}`}
        accessibilityHint={t("tool.details")}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.card,
          {
            borderColor: palette.border,
            backgroundColor: pressed ? palette.pressed : palette.surface,
          },
        ]}
      >
        <Text style={[styles.icon, { color: palette.textMuted }]}>{toolIcon(tool.name)}</Text>
        <Text numberOfLines={1} style={[styles.label, { color: palette.text }]}>
          {label}
        </Text>
        <Text style={[styles.state, { color: tone }]}>{state}</Text>
      </Pressable>
      {decision ? (
        <Text style={[styles.decision, { color: palette.textMuted }]}>{decision}</Text>
      ) : null}
      {tool.ruleAllowed ? (
        <Text style={[styles.decision, { color: palette.textMuted }]}>{t("tool.ruleAllowed")}</Text>
      ) : null}
      {tool.answeredInChat ? (
        <Text style={[styles.decision, { color: palette.textMuted }]}>
          {t("tool.answeredInChat")}
        </Text>
      ) : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label} tall>
        <Text style={[styles.meta, { color: palette.textMuted }]}>
          {tool.name} · {state}
        </Text>
        {tool.input ? <Detail title={t("tool.input")} value={tool.input} /> : null}
        {tool.output ? <Detail title={t("tool.output")} value={tool.output} /> : null}
      </Sheet>
    </>
  )
}

const Detail = (props: { readonly title: string; readonly value: string }) => {
  const { palette } = useApp()
  return (
    <View style={styles.detail}>
      <Text style={[styles.detailTitle, { color: palette.text }]}>{props.title}</Text>
      <View style={[styles.box, { backgroundColor: palette.surface, borderColor: palette.border }]}>
        <Text selectable style={[styles.mono, { color: palette.text }]}>
          {props.value.length > 20_000 ? `${props.value.slice(0, 20_000)}…` : props.value}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s,
    borderWidth: 1,
    borderRadius: radius.m,
    paddingHorizontal: space.m,
    minHeight: 44,
  },
  icon: { fontSize: text.s, width: 20, textAlign: "center", fontFamily: "Menlo" },
  label: { flex: 1, fontSize: text.s, fontWeight: "500" },
  state: { fontSize: text.xs, fontWeight: "600" },
  decision: { fontSize: text.xs },
  meta: { fontSize: text.s },
  detail: { gap: space.xs },
  detailTitle: { fontSize: text.s, fontWeight: "600" },
  box: { borderWidth: 1, borderRadius: radius.m, padding: space.m },
  mono: { fontFamily: "Menlo", fontSize: text.xs, lineHeight: 17 },
})
