import {
  type Agent,
  type ChatMessage,
  foldedToolsKey,
  groupParts,
  type MessagePart,
  type PartSegment,
  shownName,
  thoughtIsLive,
} from "@robot/shared"
import { memo, type ReactNode, useState } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native"
import { errorText, fileSizeText } from "../i18n/index.ts"
import { Markdown } from "../markdown/Markdown.tsx"
import { useApp } from "../state/context.tsx"
import { radius, space, text } from "../theme/palette.ts"
import { AvatarMark } from "../ui/AvatarMark.tsx"
import { Face } from "../ui/Face.tsx"
import { ShownText } from "../ui/names.tsx"
import type { RowMessage } from "./rows.ts"
import { ToolCard } from "./ToolCard.tsx"

type SetupFailed = Extract<MessagePart, { kind: "note"; note: "setup_failed" }>

/** The translation key of a setup that did not succeed (spec 035). */
function setupFailedKey(
  code: SetupFailed["code"],
): "chat.note.setup_failed" | "chat.note.setup_failed_timeout" | "chat.note.setup_failed_spawn" {
  switch (code) {
    case "exit":
      return "chat.note.setup_failed"
    case "timeout":
      return "chat.note.setup_failed_timeout"
    case "spawn":
      return "chat.note.setup_failed_spawn"
    default: {
      const never: never = code
      return never
    }
  }
}

/** A chat message or a channel message: what a row needs of both. */
export interface ShownMessage extends RowMessage {
  readonly status: ChatMessage["status"]
  readonly error: ChatMessage["error"]
  readonly fromDevice: string | null
  /** The name of the sender of a message from Teams (spec 028). The row shows the mark. */
  readonly fromTeams?: string | undefined
  readonly unread?: ChatMessage["unread"]
}

export type FilePart = Extract<MessagePart, { kind: "file" }>
export type ToolPart = Extract<MessagePart, { kind: "tool" }>

export interface RowActions {
  readonly onLongPress: (message: ShownMessage) => void
  readonly onQuotePress: (messageId: string) => void
  readonly onFile: (message: ShownMessage, file: FilePart) => void
  readonly onRetry?: (message: ShownMessage) => void
  /** The card of an approval or a question, when the row has one (P3). */
  readonly renderAsk?: (message: ShownMessage, tool: ToolPart) => ReactNode
}

/**
 * One row of a conversation, as on the desktop (spec 003): the face, a header with the name, a
 * BOT tag and the time, then the parts. Rows of one sender within 5 minutes have no header.
 */
export const MessageRow = memo(
  (props: {
    readonly message: ShownMessage
    readonly head: boolean
    readonly agent: Agent | undefined
    /**
     * The whole name of the organization that the prefix of the agent shows (spec 036, 011), or
     * null for no prefix (no organization, or the switch of this phone is off).
     */
    readonly organization: string | null
    readonly quoted: { readonly name: string; readonly text: string } | null
    readonly flash: boolean
    /** The name of this phone: its own messages have no "from" line (spec 012). */
    readonly ownDevice: string | null
    readonly actions: RowActions
  }) => {
    const { t, palette, locale, errorLine, prefs } = useApp()
    const { message, agent } = props
    const segments = groupParts(message.parts, !prefs.showToolSteps)
    const isAgent = message.author === "agent"
    const name = isAgent ? (agent?.name ?? "?") : t("chat.you")
    const shown = shownName(name, isAgent ? props.organization : null, true)
    const time = new Date(message.createdAt).toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    })
    return (
      <Pressable
        testID={`message.${message.author}`}
        onLongPress={() => props.actions.onLongPress(message)}
        delayLongPress={350}
        accessibilityHint={t("chat.menu")}
        style={[
          styles.row,
          props.head ? styles.headRow : undefined,
          props.flash ? { backgroundColor: palette.selected } : undefined,
        ]}
      >
        <View style={styles.side}>
          {props.head ? (
            isAgent ? (
              <Face face={agent?.face} image={agent?.faceImage} size={36} />
            ) : (
              <AvatarMark glyph={t("chat.you").slice(0, 1)} size={36} />
            )
          ) : null}
        </View>
        <View style={styles.main}>
          {props.head ? (
            <View style={styles.header}>
              <ShownText
                shown={shown}
                numberOfLines={1}
                style={[styles.name, { color: palette.text }]}
              />
              {isAgent ? (
                <View style={[styles.bot, { borderColor: palette.border }]}>
                  <Text style={[styles.botText, { color: palette.textMuted }]}>
                    {t("chat.bot")}
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.time, { color: palette.textMuted }]}>{time}</Text>
            </View>
          ) : null}
          {props.quoted ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => message.replyTo && props.actions.onQuotePress(message.replyTo)}
              style={[styles.quote, { borderLeftColor: palette.accent }]}
            >
              <Text numberOfLines={1} style={[styles.small, { color: palette.textMuted }]}>
                {t("chat.quoted", { name: props.quoted.name, text: props.quoted.text })}
              </Text>
            </Pressable>
          ) : null}
          {segments.map((segment, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments have no id; the order is stable.
            <Segment key={i} segment={segment} message={message} actions={props.actions} />
          ))}
          {message.status === "streaming" && message.parts.length === 0 ? (
            <ActivityIndicator style={styles.spinner} color={palette.textMuted} />
          ) : null}
          {message.unread === "waiting" || message.unread === "handed" ? (
            <Text style={[styles.small, { color: palette.textMuted }]}>{t("chat.readNext")}</Text>
          ) : null}
          {message.status === "stopped" ? (
            <Text style={[styles.small, { color: palette.textMuted }]}>{t("chat.stopped")}</Text>
          ) : null}
          {message.status === "failed" ? (
            <View style={styles.failed}>
              <Text style={[styles.small, { color: palette.danger }]}>
                {message.error ? errorLine(message.error) : t("chat.failed")}
              </Text>
              {props.actions.onRetry ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => props.actions.onRetry?.(message)}
                >
                  <Text style={[styles.small, { color: palette.accent, fontWeight: "600" }]}>
                    {t("chat.retry")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {message.fromDevice && message.fromDevice !== props.ownDevice ? (
            <Text style={[styles.small, { color: palette.textMuted }]}>
              {t("chat.from", { name: message.fromDevice })}
            </Text>
          ) : null}
          {message.fromTeams ? (
            <Text style={[styles.small, { color: palette.textMuted }]}>
              {t("chat.fromTeams", { name: message.fromTeams })}
            </Text>
          ) : null}
        </View>
      </Pressable>
    )
  },
)

/**
 * A run of finished plain tool steps as one muted line, when the switch "Show tool steps" is
 * off. A tap opens it to read the cards. A folded run never holds a card that waits.
 */
const ToolsFolded = (props: { readonly tools: readonly ToolPart[] }) => {
  const { t, palette } = useApp()
  const [open, setOpen] = useState(false)
  return (
    <View style={styles.tool}>
      <Pressable
        testID="tools-folded"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
      >
        <Text style={[styles.small, { color: palette.textMuted }]}>
          {open ? "▾ " : "▸ "}
          {t(foldedToolsKey(props.tools.length), { count: props.tools.length })}
        </Text>
      </Pressable>
      {open ? props.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />) : null}
    </View>
  )
}

const Segment = (props: {
  readonly segment: PartSegment
  readonly message: ShownMessage
  readonly actions: RowActions
}) =>
  props.segment.kind === "tools" ? (
    <ToolsFolded tools={props.segment.parts} />
  ) : (
    <Part part={props.segment.part} message={props.message} actions={props.actions} />
  )

const Part = (props: {
  readonly part: MessagePart
  readonly message: ShownMessage
  readonly actions: RowActions
}) => {
  const { t, palette, locale } = useApp()
  const [open, setOpen] = useState(false)
  const { part, message } = props
  switch (part.kind) {
    case "text":
      return message.author === "agent" ? (
        <Markdown source={part.text} scope={`message:${message.id}`} />
      ) : (
        <Text selectable style={[styles.body, { color: palette.text }]}>
          {part.text}
        </Text>
      )
    case "file":
      return (
        <Pressable
          testID={`file.${part.name}`}
          accessibilityRole="button"
          accessibilityLabel={t("file.open", { name: part.name })}
          onPress={() => props.actions.onFile(message, part)}
          style={({ pressed }) => [
            styles.chip,
            {
              borderColor: palette.border,
              backgroundColor: pressed ? palette.pressed : palette.surface,
            },
          ]}
        >
          <Text style={[styles.chipIcon, { color: palette.textMuted }]}>▤</Text>
          <Text numberOfLines={1} style={[styles.chipName, { color: palette.text }]}>
            {part.name}
          </Text>
          <Text style={[styles.small, { color: palette.textMuted }]}>
            {fileSizeText(locale, part.size)}
          </Text>
        </Pressable>
      )
    case "thinking":
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
        >
          <Text style={[styles.small, { color: palette.textMuted, fontStyle: "italic" }]}>
            {open ? "▾ " : "▸ "}
            {thoughtIsLive(message) ? t("chat.thinking") : t("chat.thought")}
          </Text>
          {open ? (
            <Text selectable style={[styles.small, { color: palette.textMuted }]}>
              {part.text}
            </Text>
          ) : null}
        </Pressable>
      )
    case "skill":
      return (
        <View
          style={[styles.chip, { borderColor: palette.border, backgroundColor: palette.surface }]}
        >
          <Text style={[styles.chipIcon, { color: palette.textMuted }]}>/</Text>
          <Text numberOfLines={1} style={[styles.chipName, { color: palette.text }]}>
            {part.name}
          </Text>
        </View>
      )
    case "note":
      return (
        <Text style={[styles.small, { color: palette.textMuted }]}>
          {part.note === "watch_unchanged"
            ? t("chat.note.watch", { routine: part.routine })
            : part.note === "compact_failed"
              ? t("chat.note.compact_failed", { reason: errorText(locale, part.code) })
              : part.note === "connection_down"
                ? t("chat.note.connection_down", { name: part.name })
                : part.note === "connection_held"
                  ? t("chat.note.connection_held", { name: part.name })
                  : part.note === "handed_over"
                    ? // The phone shows the main thread only, so the line is plain text (spec 011).
                      t("chat.note.handed_over", { name: part.toName })
                    : part.note === "kept_going"
                      ? t("chat.note.kept_going", { n: part.n, of: part.of })
                      : part.note === "busy_retry"
                        ? t("chat.note.busy_retry", { n: part.n, of: part.of })
                        : part.note === "tree_repaired"
                          ? t(`chat.note.tree_repaired.${part.why}`)
                          : part.note === "backup_goes_on"
                            ? part.until === null
                              ? t("chat.note.backup_goes_on", {
                                  main: part.main,
                                  backup: part.backup,
                                })
                              : t("chat.note.backup_goes_on_until", {
                                  main: part.main,
                                  backup: part.backup,
                                  time: new Date(part.until).toLocaleTimeString(locale, {
                                    hour: "numeric",
                                    minute: "2-digit",
                                  }),
                                })
                            : part.note === "setup_failed"
                              ? t(setupFailedKey(part.code), { name: part.name })
                              : t(`chat.note.starter.${part.what}.${part.why}`, {
                                  name: part.name,
                                })}
        </Text>
      )
    case "tool":
      return (
        <View style={styles.tool}>
          <ToolCard tool={part} />
          {part.state === "waiting" && part.ask ? props.actions.renderAsk?.(message, part) : null}
        </View>
      )
  }
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.m, paddingHorizontal: space.l, paddingVertical: 2 },
  headRow: { paddingTop: space.m },
  side: { width: 36 },
  main: { flex: 1, gap: space.xs, minWidth: 0 },
  header: { flexDirection: "row", alignItems: "center", gap: space.s },
  name: { fontSize: text.m, fontWeight: "600", flexShrink: 1 },
  bot: { borderWidth: 1, borderRadius: radius.s, paddingHorizontal: 4 },
  botText: { fontSize: 10, fontWeight: "700" },
  time: { fontSize: text.xs },
  quote: { borderLeftWidth: 2, paddingLeft: space.s },
  body: { fontSize: text.m, lineHeight: 22 },
  small: { fontSize: text.s, lineHeight: 19 },
  spinner: { alignSelf: "flex-start" },
  failed: { flexDirection: "row", gap: space.m, alignItems: "center", flexWrap: "wrap" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s,
    borderWidth: 1,
    borderRadius: radius.m,
    paddingHorizontal: space.m,
    minHeight: 44,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  chipIcon: { fontSize: text.m },
  chipName: { fontSize: text.s, fontWeight: "500", flexShrink: 1 },
  tool: { gap: space.s },
})
