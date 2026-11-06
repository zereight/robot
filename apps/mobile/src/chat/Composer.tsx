import { ATTACH_BYTES, ATTACH_MAX } from "@robot/phone"
import { type Agent, insertMention, mentionEntries, openMention } from "@robot/shared"
import { useEffect, useRef, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { fileSizeText } from "../i18n/index.ts"
import { type Picked, pickFiles, pickPhotos } from "../platform/files.ts"
import { useApp } from "../state/context.tsx"
import { radius, space, text } from "../theme/palette.ts"
import { Face } from "../ui/Face.tsx"
import { ErrorLine } from "../ui/kit.tsx"
import { Sheet } from "../ui/Sheet.tsx"
import { createSendGate, filesAfterSend, textAfterSend } from "./sending.ts"

export interface Draft {
  readonly text: string
  readonly files: readonly Picked[]
}

/**
 * The message box (spec 003, 011): text, attach (photos and files), send, and stop while the agent
 * works. A reply shows its quote line above the box.
 */
export const Composer = (props: {
  readonly placeholder: string
  readonly working: boolean
  /** A line that says why the box cannot send now (offline, removed), or null. */
  readonly blocked: string | null
  /** The other agents that an `@` can name (not archived, spec 003). The list has no `@all`. */
  readonly mentions?: readonly Agent[] | undefined
  readonly reply: { readonly name: string; readonly text: string } | null
  readonly onCancelReply: () => void
  readonly onSend: (
    draft: Draft,
    onProgress: (sent: number, total: number) => void,
  ) => Promise<void>
  readonly onStop: () => Promise<unknown>
}) => {
  const { t, palette, locale, errorLine } = useApp()
  const [value, setValue] = useState("")
  const [files, setFiles] = useState<readonly Picked[]>([])
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  // A send runs once at a time. The flag does not wait for a render, so two quick taps send once;
  // the state turns the button off while the message goes out.
  const gate = useRef(createSendGate()).current
  const [sending, setSending] = useState(false)
  // The `@` list: where the caret is, and a caret that a pick asks for. The ask holds for one
  // render only, so the box is free again at once.
  const [caret, setCaret] = useState(0)
  const [forced, setForced] = useState<{ start: number; end: number } | undefined>()
  useEffect(() => {
    if (forced) setForced(undefined)
  }, [forced])
  const members = props.mentions
  const openAt = members ? openMention(value, caret) : null
  const entries = members && openAt && !props.blocked ? mentionEntries(members, openAt.query) : []
  const pickMention = (name: string) => {
    if (!openAt) return
    const next = insertMention(value, openAt, caret, name)
    setValue(next.text)
    setCaret(next.caret)
    setForced({ start: next.caret, end: next.caret })
  }

  const add = (picked: readonly Picked[]) => {
    setError(null)
    const next = [...files, ...picked.filter((p) => !files.some((f) => f.uri === p.uri))]
    const big = next.find((f) => f.size > ATTACH_BYTES)
    if (big) setError(errorLine({ code: "file_too_large", detail: big.name }))
    else if (next.length > ATTACH_MAX) setError(errorLine({ code: "too_many_files" }))
    setFiles(next.filter((f) => f.size <= ATTACH_BYTES).slice(0, ATTACH_MAX))
  }

  const send = async () => {
    const draft = { text: value.trim(), files }
    if (!draft.text && files.length === 0) return
    if (!gate.enter()) return
    const sentValue = value
    setSending(true)
    setError(null)
    setProgress(files.length > 0 ? 0 : null)
    try {
      await props.onSend(draft, (sent, total) =>
        setProgress(total > 0 ? Math.round((sent / total) * 100) : null),
      )
      // Text and files that the user added during the send stay.
      setValue((current) => textAfterSend(current, sentValue))
      setFiles((current) => filesAfterSend(current, draft.files))
    } catch (e) {
      setError(errorLine(e))
    } finally {
      gate.leave()
      setSending(false)
      setProgress(null)
    }
  }

  const canSend = !props.blocked && (value.trim().length > 0 || files.length > 0) && !sending
  const showStop = props.working && !canSend && !props.blocked

  return (
    <View
      style={[styles.root, { borderTopColor: palette.border, backgroundColor: palette.background }]}
    >
      {props.blocked ? (
        <Text style={[styles.small, { color: palette.textMuted }]}>{props.blocked}</Text>
      ) : null}
      {props.reply ? (
        <View style={[styles.reply, { borderLeftColor: palette.accent }]}>
          <Text numberOfLines={1} style={[styles.small, styles.grow, { color: palette.textMuted }]}>
            {t("chat.quoted", { name: props.reply.name, text: props.reply.text })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("chat.replyCancel")}
            hitSlop={10}
            onPress={props.onCancelReply}
          >
            <Text style={[styles.small, { color: palette.textMuted }]}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={styles.chips}>
          {files.map((f) => (
            <View
              key={f.id}
              style={[
                styles.chip,
                { borderColor: palette.border, backgroundColor: palette.surface },
              ]}
            >
              <Text numberOfLines={1} style={[styles.chipName, { color: palette.text }]}>
                {f.name}
              </Text>
              <Text style={[styles.xs, { color: palette.textMuted }]}>
                {fileSizeText(locale, f.size)}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("chat.attach.remove", { name: f.name })}
                hitSlop={10}
                onPress={() => setFiles(files.filter((x) => x.id !== f.id))}
              >
                <Text style={[styles.small, { color: palette.textMuted }]}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {progress !== null ? (
        <Text style={[styles.small, { color: palette.textMuted }]}>
          {t("chat.sending", { percent: progress })}
        </Text>
      ) : null}
      <ErrorLine text={error} />
      {entries.length > 0 ? (
        <ScrollView
          testID="composer.mentions"
          accessibilityLabel={t("chat.mentions")}
          keyboardShouldPersistTaps="handled"
          style={[
            styles.mentions,
            { borderColor: palette.border, backgroundColor: palette.surface },
          ]}
        >
          {entries.map((member) => (
            <Pressable
              key={member.id}
              testID={`composer.mention.${member.name}`}
              accessibilityRole="button"
              accessibilityLabel={`@${member.name}`}
              onPress={() => pickMention(member.name)}
              style={({ pressed }) => [
                styles.mention,
                { backgroundColor: pressed ? palette.pressed : "transparent" },
              ]}
            >
              <Face face={member.face} image={member.faceImage} size={24} />
              <Text style={[styles.mentionName, { color: palette.text }]}>@{member.name}</Text>
              <Text
                numberOfLines={1}
                style={[styles.xs, styles.grow, { color: palette.textMuted }]}
              >
                {member.role}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={styles.bar}>
        <Pressable
          testID="composer.attach"
          accessibilityRole="button"
          accessibilityLabel={t("chat.attach")}
          disabled={!!props.blocked}
          onPress={() => setMenu(true)}
          style={({ pressed }) => [
            styles.round,
            {
              backgroundColor: pressed ? palette.pressed : palette.surface,
              opacity: props.blocked ? 0.4 : 1,
            },
          ]}
        >
          <Text style={[styles.plus, { color: palette.text }]}>+</Text>
        </Pressable>
        <TextInput
          testID="composer.input"
          accessibilityLabel={props.placeholder}
          placeholder={props.placeholder}
          placeholderTextColor={palette.textMuted}
          value={value}
          onChangeText={setValue}
          onSelectionChange={(e) => setCaret(e.nativeEvent.selection.start)}
          {...(forced ? { selection: forced } : {})}
          editable={!props.blocked}
          multiline
          style={[
            styles.input,
            { color: palette.text, backgroundColor: palette.surface, borderColor: palette.border },
          ]}
        />
        {showStop ? (
          <Pressable
            testID="composer.stop"
            accessibilityRole="button"
            accessibilityLabel={t("chat.stop")}
            onPress={() => void props.onStop().catch((e) => setError(errorLine(e)))}
            style={({ pressed }) => [
              styles.round,
              { backgroundColor: palette.danger, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <View style={[styles.stopSquare, { backgroundColor: palette.accentText }]} />
          </Pressable>
        ) : (
          <Pressable
            testID="composer.send"
            accessibilityRole="button"
            accessibilityLabel={t("chat.send")}
            accessibilityState={{ disabled: !canSend }}
            disabled={!canSend}
            onPress={send}
            style={({ pressed }) => [
              styles.round,
              { backgroundColor: palette.accent, opacity: !canSend ? 0.4 : pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={[styles.arrow, { color: palette.accentText }]}>↑</Text>
          </Pressable>
        )}
      </View>
      <Sheet
        visible={menu}
        onClose={() => setMenu(false)}
        title={t("chat.attach")}
        actions={[
          {
            label: t("chat.attach.photos"),
            onPress: () => void pickPhotos().then(add, (e) => setError(errorLine(e))),
          },
          {
            label: t("chat.attach.files"),
            onPress: () => void pickFiles().then(add, (e) => setError(errorLine(e))),
          },
        ]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { borderTopWidth: StyleSheet.hairlineWidth, padding: space.s, gap: space.xs },
  small: { fontSize: text.s, lineHeight: 19, paddingHorizontal: space.xs },
  xs: { fontSize: text.xs },
  grow: { flex: 1 },
  reply: {
    flexDirection: "row",
    alignItems: "center",
    borderLeftWidth: 2,
    gap: space.s,
    marginHorizontal: space.xs,
  },
  mentions: { maxHeight: 192, borderWidth: 1, borderRadius: radius.m },
  mention: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s,
    minHeight: 44,
    paddingHorizontal: space.m,
  },
  mentionName: { fontSize: text.m, fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.s,
    borderWidth: 1,
    borderRadius: radius.m,
    paddingHorizontal: space.s,
    minHeight: 36,
    maxWidth: "100%",
  },
  chipName: { fontSize: text.s, maxWidth: 180 },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: space.s },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderWidth: 1,
    borderRadius: 22,
    paddingHorizontal: space.l,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: text.m,
  },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  plus: { fontSize: 24, lineHeight: 26 },
  arrow: { fontSize: 20, fontWeight: "700" },
  stopSquare: { width: 14, height: 14, borderRadius: 2 },
})
