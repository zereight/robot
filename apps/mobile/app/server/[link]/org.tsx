import type { AgentState } from "@robot/shared"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useMemo, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import type { buildOrgList, OrgAgentRow, OrgBlock } from "../../../src/orgchart/list.ts"
import { orgScreen } from "../../../src/orgchart/screen.ts"
import {
  agentLabel,
  agentStateText,
  blockLabel,
  blockLine,
  blockName,
  handoffLabel,
  moreLabel,
} from "../../../src/orgchart/text.ts"
import { useOrgChart } from "../../../src/orgchart/useOrgChart.ts"
import { useApp, useServer } from "../../../src/state/context.tsx"
import { type Palette, radius, space, text } from "../../../src/theme/palette.ts"
import { AvatarMark } from "../../../src/ui/AvatarMark.tsx"
import { Face } from "../../../src/ui/Face.tsx"
import { Body, Button, ErrorLine, Notice, Screen } from "../../../src/ui/kit.tsx"
import { Sheet } from "../../../src/ui/Sheet.tsx"

/**
 * Org chart (spec 029, "Phone"; spec 011, screen 8): the main agent, the channels with their
 * members and leads, the state of each agent, and the work that agents handed to each other in
 * the last 7 days, as a read-only list. It needs only the link. The list is not cached: it lives
 * in memory while the screen is open, and it is not drawn when the server is not online.
 */
export default function OrgChart() {
  const { link } = useLocalSearchParams<{ link: string }>()
  const { t, errorLine } = useApp()
  const view = useServer(link)
  const { phase, refresh } = useOrgChart(link)
  const serverState = view?.state
  const shown = useMemo(
    () => (serverState ? orgScreen(serverState, phase) : null),
    [serverState, phase],
  )
  if (!view || !shown) return <Screen>{null}</Screen>
  const name = view.link.name
  return (
    <>
      <Stack.Screen options={{ title: t("org.title") }} />
      <Screen testID="org" onRefresh={async () => refresh()}>
        {shown.kind === "offline" ? (
          <View testID="org.offline">
            <Notice text={t("chat.offlineBox", { name })} />
          </View>
        ) : shown.kind === "loading" ? (
          <Body muted>{t("places.loading")}</Body>
        ) : shown.kind === "unsupported" ? (
          <View testID="org.unsupported">
            <Notice text={t("org.openOnServer", { name })} />
          </View>
        ) : shown.kind === "failed" ? (
          <>
            <ErrorLine testID="org.failed" text={errorLine({ code: shown.code })} />
            <Button kind="secondary" label={t("common.retry")} onPress={refresh} />
          </>
        ) : shown.kind === "empty" ? (
          <Body muted style={styles.empty}>
            {t("org.empty")}
          </Body>
        ) : (
          <List link={link} list={shown.list} />
        )}
      </Screen>
    </>
  )
}

const openChat = (link: string, agentId: string) =>
  router.push({
    pathname: "/server/[link]/[kind]/[id]",
    params: { link, kind: "agent", id: agentId },
  })

const openChannel = (link: string, channelId: string) =>
  router.push({
    pathname: "/server/[link]/[kind]/[id]",
    params: { link, kind: "channel", id: channelId },
  })

/** The colour of the dot and the word of a state. The word carries the meaning; the colour helps. */
const stateColor = (palette: Palette, state: AgentState) =>
  state === "working"
    ? palette.success
    : state === "waiting"
      ? palette.accent
      : state === "offline"
        ? palette.danger
        : palette.textMuted

const List = (props: { readonly link: string; readonly list: ReturnType<typeof buildOrgList> }) => {
  const { t, palette } = useApp()
  const { list, link } = props
  const root = list.root
  // The block whose rows behind "+<n> more" are open.
  const [more, setMore] = useState<string | null>(null)
  const open = list.blocks.find((b) => b.key === more)
  return (
    <>
      {/* The first row: the root. */}
      <View testID="org.root" style={[styles.card, cardColors(palette)]}>
        {root.kind === "main" ? (
          <AgentRow
            testID="org.root.main"
            row={root.agent}
            mark="main"
            onPress={() => openChat(link, root.agent.agentId)}
          />
        ) : (
          <View style={[styles.row, styles.centered]} accessible accessibilityLabel={t("org.you")}>
            <AvatarMark glyph={t("chat.you").slice(0, 1)} size={36} />
            <Text style={[styles.name, { color: palette.text }]}>{t("org.you")}</Text>
          </View>
        )}
      </View>

      {list.blocks.map((block) => (
        <View key={block.key} style={styles.block}>
          <BlockHeader link={link} block={block} />
          <View style={[styles.card, cardColors(palette)]}>
            {block.rows.map((row, index) => (
              <AgentRow
                key={row.key}
                testID={`org.agent.${block.name || "none"}.${row.name}`}
                row={row}
                first={index === 0}
                onPress={() => openChat(link, row.agentId)}
              />
            ))}
            {block.more.length > 0 ? (
              <Pressable
                testID={`org.more.${block.name || "none"}`}
                accessibilityRole="button"
                accessibilityLabel={moreLabel(t, block)}
                accessibilityHint={t("org.more.hint")}
                onPress={() => setMore(block.key)}
                style={({ pressed }) => [
                  styles.moreRow,
                  { borderTopColor: palette.border },
                  { backgroundColor: pressed ? palette.pressed : "transparent" },
                ]}
              >
                <Text style={[styles.moreText, { color: palette.accent }]}>
                  {t("org.more", { count: block.more.length })}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}

      {list.handoffs.length > 0 ? (
        <View testID="org.handoffs" style={styles.block}>
          <Text accessibilityRole="header" style={[styles.blockTitle, { color: palette.text }]}>
            {t("org.handoffs")}
          </Text>
          <View style={[styles.card, cardColors(palette)]}>
            {list.handoffs.map((row, index) => (
              // A tap on a hand-off row does nothing, so it is not a button.
              <View
                key={row.key}
                accessible
                accessibilityLabel={handoffLabel(t, row)}
                style={[
                  styles.handoff,
                  index > 0 ? { borderTopColor: palette.border, borderTopWidth: hairline } : null,
                ]}
              >
                <Text style={[styles.handoffNames, { color: palette.text }]}>
                  {`${row.from} → ${row.to}`}
                </Text>
                <Text style={[styles.handoffCount, { color: palette.text }]}>{row.count}</Text>
              </View>
            ))}
          </View>
          {list.handoffsCapped ? (
            <Text testID="org.handoffs.capped" style={[styles.note, { color: palette.textMuted }]}>
              {t("org.handoffs.capped")}
            </Text>
          ) : null}
        </View>
      ) : null}

      <Sheet
        visible={open !== undefined}
        onClose={() => setMore(null)}
        {...(open ? { title: t("org.more.title", { channel: blockName(t, open) }) } : {})}
      >
        {(open?.more ?? []).map((m) => (
          <Pressable
            key={m.key}
            testID={`org.moreRow.${m.name}`}
            accessibilityRole="button"
            accessibilityLabel={`${m.name}, ${agentStateText(t, m.state)}`}
            accessibilityHint={t("org.agent.hint")}
            onPress={() => {
              setMore(null)
              openChat(link, m.agentId)
            }}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? palette.pressed : "transparent" },
            ]}
          >
            <Face face={m.face} size={36} />
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.name, { color: palette.text }]}>
                {m.name}
              </Text>
              <StateLine state={m.state} />
            </View>
          </Pressable>
        ))}
      </Sheet>
    </>
  )
}

const BlockHeader = (props: { readonly link: string; readonly block: OrgBlock }) => {
  const { t, palette } = useApp()
  const { block, link } = props
  const channelId = block.channelId
  const content = (
    <>
      {channelId !== null ? <AvatarMark glyph="#" size={32} /> : null}
      <View style={styles.rowText}>
        <Text style={[styles.blockTitle, { color: palette.text }]}>{blockName(t, block)}</Text>
        <Text style={[styles.blockLine, { color: palette.textMuted }]}>{blockLine(t, block)}</Text>
      </View>
      {channelId !== null ? (
        <Text style={[styles.chevron, { color: palette.textMuted }]}>›</Text>
      ) : null}
    </>
  )
  // A tap on the header of a channel opens the channel. "No channel" is no channel: it opens nothing.
  return channelId === null ? (
    <View
      testID="org.block.none"
      accessible
      accessibilityRole="header"
      accessibilityLabel={blockLabel(t, block)}
      style={styles.blockHeader}
    >
      {content}
    </View>
  ) : (
    <Pressable
      testID={`org.block.${block.name}`}
      accessibilityRole="button"
      accessibilityLabel={blockLabel(t, block)}
      accessibilityHint={t("org.channel.hint")}
      onPress={() => openChannel(link, channelId)}
      style={({ pressed }) => [styles.blockHeader, { opacity: pressed ? 0.6 : 1 }]}
    >
      {content}
    </Pressable>
  )
}

/** The state of an agent: a dot and the word. */
const StateLine = (props: { readonly state: AgentState; readonly role?: string }) => {
  const { t, palette } = useApp()
  const colour = stateColor(palette, props.state)
  return (
    <View style={styles.stateLine}>
      <View style={[styles.dot, { backgroundColor: colour }]} />
      <Text numberOfLines={1} style={[styles.small, styles.fill, { color: palette.textMuted }]}>
        <Text style={[styles.stateWord, { color: colour }]}>{agentStateText(t, props.state)}</Text>
        {props.role ? ` · ${props.role}` : ""}
      </Text>
    </View>
  )
}

const AgentRow = (props: {
  readonly row: OrgAgentRow
  readonly mark?: "main"
  readonly first?: boolean
  readonly testID: string
  readonly onPress: () => void
}) => {
  const { t, palette } = useApp()
  const { row } = props
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={agentLabel(t, row, props.mark)}
      accessibilityHint={t("org.agent.hint")}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.row,
        props.first === false ? { borderTopColor: palette.border } : null,
        { backgroundColor: pressed ? palette.pressed : "transparent" },
      ]}
    >
      <Face face={row.face} size={36} />
      <View style={styles.rowText}>
        <View style={styles.nameLine}>
          <Text numberOfLines={1} style={[styles.name, styles.nameText, { color: palette.text }]}>
            {row.name}
          </Text>
          {props.mark === "main" ? (
            <Mark text={t("org.main")} testID={`${props.testID}.main`} />
          ) : null}
          {row.isLead ? <Mark text={t("org.lead")} testID={`${props.testID}.lead`} /> : null}
        </View>
        <StateLine state={row.state} {...(row.role ? { role: row.role } : {})} />
        {row.label ? (
          <Text testID={`${props.testID}.task`} style={[styles.task, { color: palette.text }]}>
            {row.label}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

/** A small mark after a name: "Lead", or "Main agent". */
const Mark = (props: { readonly text: string; readonly testID: string }) => {
  const { palette } = useApp()
  return (
    <Text
      testID={props.testID}
      style={[styles.mark, { color: palette.accent, borderColor: palette.accent }]}
    >
      {props.text}
    </Text>
  )
}

const hairline = StyleSheet.hairlineWidth
const cardColors = (palette: Palette) => ({
  backgroundColor: palette.surface,
  borderColor: palette.border,
})

const styles = StyleSheet.create({
  empty: { fontSize: text.m },
  block: { gap: space.s },
  blockHeader: { flexDirection: "row", alignItems: "center", gap: space.m, minHeight: 44 },
  blockTitle: { fontSize: text.l, fontWeight: "700" },
  blockLine: { fontSize: text.s, lineHeight: 19 },
  chevron: { fontSize: text.xl },
  card: { borderWidth: 1, borderRadius: radius.l, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.m,
    minHeight: 56,
    padding: space.m,
    borderTopWidth: hairline,
    borderTopColor: "transparent",
  },
  centered: { alignItems: "center" },
  rowText: { flex: 1, gap: 2, minWidth: 0 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: space.s },
  name: { fontSize: text.m, fontWeight: "600" },
  nameText: { flexShrink: 1 },
  mark: {
    fontSize: text.xs,
    fontWeight: "600",
    paddingHorizontal: 6,
    borderWidth: 1,
    borderRadius: radius.s,
    overflow: "hidden",
  },
  stateLine: { flexDirection: "row", alignItems: "center", gap: space.s },
  dot: { width: 8, height: 8, borderRadius: 4 },
  fill: { flex: 1, minWidth: 0 },
  small: { fontSize: text.s, lineHeight: 19 },
  stateWord: { fontWeight: "600" },
  task: { fontSize: text.s, lineHeight: 19 },
  moreRow: {
    minHeight: 48,
    paddingHorizontal: space.m,
    justifyContent: "center",
    borderTopWidth: hairline,
  },
  moreText: { fontSize: text.m, fontWeight: "600" },
  handoff: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    minHeight: 48,
    paddingHorizontal: space.m,
    paddingVertical: space.s,
  },
  handoffNames: { flex: 1, fontSize: text.m },
  handoffCount: { fontSize: text.m, fontWeight: "700" },
  note: { fontSize: text.s, lineHeight: 19 },
})
