import { type QuietTurn, quietOfChat } from "@robot/shared"
import * as Clipboard from "expo-clipboard"
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { AskCard } from "../../../../src/chat/AskCard.tsx"
import { Composer } from "../../../../src/chat/Composer.tsx"
import { MessageRow, type RowActions, type ShownMessage } from "../../../../src/chat/MessageRow.tsx"
import { QuietLine } from "../../../../src/chat/QuietLine.tsx"
import { buildRows, messageText, quoteText, type Row } from "../../../../src/chat/rows.ts"
import { setShownPlace } from "../../../../src/notices.ts"
import { downloadAndOpen, uploadSource } from "../../../../src/platform/files.ts"
import { useApp, useHubState, useServer } from "../../../../src/state/context.tsx"
import { radius, space, text } from "../../../../src/theme/palette.ts"
import { Button, ErrorLine, Notice } from "../../../../src/ui/kit.tsx"
import { Sheet } from "../../../../src/ui/Sheet.tsx"
import { stateText } from "../../../../src/ui/states.ts"

/** The time a hold ends: the clock time within the day, else with the weekday (spec 006). */
const untilText = (locale: string, at: number) =>
  new Intl.DateTimeFormat(
    locale,
    at - Date.now() < 20 * 3_600_000
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" },
  ).format(at)

/** The direct chat of an agent (spec 011, 003). */
export default function Conversation() {
  // The route keeps the kind of the place. A place is always an agent now (spec 011).
  const params = useLocalSearchParams<{ link: string; id: string; call?: string }>()
  const link = params.link
  const id = params.id
  const { hub, t, palette, locale, errorLine } = useApp()
  const view = useServer(link)
  const deviceName = useHubState().deviceName
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<Row<ShownMessage>>>(null)
  const offset = useRef(0)
  const [reply, setReply] = useState<ShownMessage | null>(null)
  const [menu, setMenu] = useState<ShownMessage | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [back, setBack] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState<ShownMessage | null>(null)

  // Opening the place loads it (from the cache while offline) and marks it read. When the server
  // comes back online, the hub reads the open place again by itself.
  useEffect(() => {
    void hub.openPlace(link, { kind: "agent", id })
    return () => hub.closePlace(link, { kind: "agent", id })
  }, [hub, link, id])

  // No notification for the place on the screen.
  useFocusEffect(
    useCallback(() => {
      setShownPlace({ linkId: link, kind: "agent", id })
      return () => setShownPlace(null)
    }, [link, id]),
  )

  const data = view?.data
  const agents = data?.agents ?? []
  const agentOf = useCallback(
    (agentId: string | null) => agents.find((a) => a.id === agentId),
    [agents],
  )
  const agent = agentOf(id)
  const chat = data?.chats[id]
  const messages: readonly ShownMessage[] = useMemo(
    () =>
      (chat?.messages ?? []).map((message) =>
        message.author === "agent" && message.speakerId
          ? { ...message, agentId: message.speakerId }
          : message,
      ),
    [chat],
  )
  const loaded = chat !== undefined
  // The list is drawn upside down, so the newest row is at the bottom and stays in view.
  const rows = useMemo(() => buildRows(messages).reverse(), [messages])
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages])
  const title = agent?.name ?? ""
  const nameOf = (m: ShownMessage | undefined) => {
    if (!m) return ""
    if (m.author === "user") return t("chat.you")
    const sender = agentOf(m.agentId)
    return sender ? sender.name : "?"
  }
  // The turn of this chat that shows no sign of life (spec 005, "Quiet line").
  const quietTurn: QuietTurn | undefined = quietOfChat(data?.quiet.turns ?? [], id, null)
  const working =
    agent?.state === "working" ||
    agent?.state === "waiting" ||
    messages.some((m) => m.status === "streaming")

  const jumpTo = (messageId: string) => {
    const index = rows.findIndex((r) => r.kind === "message" && r.message.id === messageId)
    if (index < 0) return
    setBack(offset.current)
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true })
    setFlash(messageId)
    setTimeout(() => setFlash((f) => (f === messageId ? null : f)), 1400)
  }

  // A tap on a notification opens the card of the call (spec 011): it scrolls there once.
  const call = params.call
  const jumped = useRef<string | null>(null)
  useEffect(() => {
    if (!call || jumped.current === call) return
    const target = messages.find((m) => m.parts.some((p) => p.kind === "tool" && p.id === call))
    if (!target) return
    jumped.current = call
    setTimeout(() => jumpTo(target.id), 300)
  })

  const openFile: RowActions["onFile"] = (message, file) => {
    const owner = message.agentId ?? id
    setError(null)
    void downloadAndOpen(hub, link, { agentId: owner, path: file.path, name: file.name }).catch(
      (e) => setError(errorLine(e)),
    )
  }

  const runRetry = (message: ShownMessage, confirmed = false) => {
    setError(null)
    hub
      .retryReply(link, id, message.id, confirmed)
      .then((result) => {
        const r = result as { started?: boolean } | undefined
        if (r && r.started === false) setRetry(message)
      })
      .catch((e) => setError(errorLine(e)))
  }

  const actions: RowActions = {
    onLongPress: setMenu,
    onQuotePress: jumpTo,
    onFile: openFile,
    onRetry: (m: ShownMessage) => runRetry(m),
    renderAsk: (message, tool) => (
      <AskCard linkId={link} agentId={message.agentId ?? id} tool={tool} />
    ),
  }

  if (!view) return null
  const blocked =
    view.state === "online"
      ? null
      : view.state === "not_allowed"
        ? t("chat.removedBox", { name: view.link.name })
        : view.state === "update_app"
          ? t("chat.updateBox")
          : t("chat.offlineBox", { name: view.link.name })

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: palette.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}
    >
      <Stack.Screen options={{ title }} />
      {view.state !== "online" ? (
        <View style={styles.banner}>
          <Notice
            tone={view.state === "not_allowed" ? "danger" : "muted"}
            text={
              view.state === "offline"
                ? loaded
                  ? t("places.offline")
                  : t("places.noCache", { name: view.link.name })
                : stateText(t, view)
            }
          />
        </View>
      ) : null}
      {/* The main model of the agent is held: the server tells until when (spec 006, 012). The
          phone has no button to end the hold in this version. */}
      {agent?.hold && agent.hold.until > Date.now() ? (
        <View style={styles.banner}>
          <Notice
            tone="muted"
            text={t("chat.backup_until", { time: untilText(locale, agent.hold.until) })}
          />
        </View>
      ) : null}
      <FlatList
        ref={list}
        testID="conversation"
        inverted
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => {
          offset.current = e.nativeEvent.contentOffset.y
        }}
        scrollEventThrottle={64}
        onScrollToIndexFailed={(info) =>
          list.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: true,
          })
        }
        ListFooterComponent={
          loaded && messages.length === 0 ? (
            <Text style={[styles.empty, { color: palette.textMuted }]}>{t("chat.empty")}</Text>
          ) : undefined
        }
        renderItem={({ item }) =>
          item.kind === "date" ? (
            <Text style={[styles.date, { color: palette.textMuted }]}>
              {new Date(item.at).toLocaleDateString(locale, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </Text>
          ) : (
            <MessageRow
              message={item.message}
              head={item.head}
              agent={agentOf(item.message.agentId)}
              quoted={
                item.message.replyTo
                  ? {
                      name: nameOf(byId.get(item.message.replyTo)),
                      text: quoteText(byId.get(item.message.replyTo)),
                    }
                  : null
              }
              flash={flash === item.message.id}
              ownDevice={deviceName}
              actions={actions}
            />
          )
        }
      />
      {back !== null ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            list.current?.scrollToOffset({ offset: back, animated: true })
            setBack(null)
          }}
          style={[styles.back, { backgroundColor: palette.elevated, borderColor: palette.border }]}
        >
          <Text style={{ color: palette.accent, fontWeight: "600" }}>{t("common.back")}</Text>
        </Pressable>
      ) : null}
      {chat && chat.queue.length > 0 ? (
        <View style={styles.queue}>
          {chat.queue.map((q) => (
            <Text
              key={q.id}
              numberOfLines={1}
              style={[styles.queued, { color: palette.textMuted }]}
            >
              {t("chat.queued")}: {q.text}
            </Text>
          ))}
        </View>
      ) : null}
      {quietTurn ? <QuietLine turn={quietTurn} receivedAt={data?.quiet.receivedAt ?? 0} /> : null}
      <View style={styles.error}>
        <ErrorLine text={error} />
      </View>
      <View style={{ paddingBottom: insets.bottom }}>
        <Composer
          placeholder={t("chat.placeholder", { name: agent?.name ?? "" })}
          mentions={agents.filter((a) => !a.archived && a.id !== id)}
          working={!!working}
          blocked={blocked}
          reply={reply ? { name: nameOf(reply), text: quoteText(reply) } : null}
          onCancelReply={() => setReply(null)}
          onStop={() => hub.stop(link, { kind: "agent", id })}
          onSend={async (draft, onProgress) => {
            await hub.send(
              link,
              {
                agentId: id,
                text: draft.text,
                replyTo: reply?.id ?? null,
                files: draft.files.map(uploadSource),
              },
              onProgress,
            )
            setReply(null)
          }}
        />
      </View>
      <Sheet
        visible={menu !== null}
        onClose={() => setMenu(null)}
        title={t("chat.menu")}
        actions={
          menu
            ? [
                ...(view.state === "online"
                  ? [
                      {
                        label: t("chat.reply"),
                        testID: "menu.reply",
                        onPress: () => setReply(menu),
                      },
                    ]
                  : []),
                {
                  label: t("common.copy"),
                  onPress: () => void Clipboard.setStringAsync(messageText(menu)),
                },
              ]
            : []
        }
      />
      <Sheet visible={retry !== null} onClose={() => setRetry(null)} title={t("chat.retry")}>
        <Text style={{ color: palette.text, fontSize: text.m, lineHeight: 22 }}>
          {t("chat.retryNote")}
        </Text>
        <Button
          label={t("chat.retryAnyway")}
          onPress={() => {
            const m = retry
            setRetry(null)
            if (m) runRetry(m, true)
          }}
        />
      </Sheet>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: { paddingHorizontal: space.l, paddingTop: space.s },
  content: { paddingVertical: space.m },
  empty: { textAlign: "center", padding: space.xl, fontSize: text.s },
  date: { textAlign: "center", fontSize: text.xs, paddingVertical: space.m, fontWeight: "600" },
  back: {
    position: "absolute",
    right: space.l,
    bottom: 140,
    borderWidth: 1,
    borderRadius: radius.round,
    paddingHorizontal: space.l,
    paddingVertical: space.s,
  },
  queue: { paddingHorizontal: space.l, gap: 2 },
  queued: { fontSize: text.s },
  error: { paddingHorizontal: space.l },
})
