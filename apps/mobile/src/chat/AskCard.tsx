import { useState } from "react"
import { StyleSheet, Text, TextInput, View } from "react-native"
import { useApp, useServer } from "../state/context.tsx"
import { radius, space, text } from "../theme/palette.ts"
import { Button, ErrorLine } from "../ui/kit.tsx"
import type { ToolPart } from "./MessageRow.tsx"

/**
 * The card of a step that waits for the user (spec 007, 011): an approval with Allow and Deny,
 * or a question with its choices and a field. A linked device has no "Always allow" (spec 012).
 * A protected card (a saved secret, spec 020) is answered on the computer only.
 */
export const AskCard = (props: {
  readonly linkId: string
  readonly agentId: string
  readonly tool: ToolPart
}) => {
  const { hub, t, palette, locale, errorLine } = useApp()
  const view = useServer(props.linkId)
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState("")
  const [error, setError] = useState<string | null>(null)
  const ask = props.tool.ask
  if (!ask) return null
  const online = view?.state === "online"

  const respond = async (value: string) => {
    setBusy(true)
    setError(null)
    try {
      await hub.respond(props.linkId, props.agentId, props.tool.id, value)
    } catch (e) {
      setError(errorLine(e))
    } finally {
      setBusy(false)
    }
  }

  const askedAt = ask.askedAt
    ? t("tool.askedAt", {
        time: new Date(ask.askedAt).toLocaleTimeString(locale, {
          hour: "numeric",
          minute: "2-digit",
        }),
      })
    : null

  const allowDeny = (
    <View style={styles.buttons}>
      <Button
        testID="ask.allow"
        label={t("tool.allow")}
        busy={busy}
        disabled={!online}
        onPress={() => void respond("allow")}
        style={styles.grow}
      />
      <Button
        testID="ask.deny"
        kind="secondary"
        label={t("tool.deny")}
        disabled={!online || busy}
        onPress={() => void respond("deny")}
        style={styles.grow}
      />
    </View>
  )

  return (
    <View
      testID={`ask.${ask.kind}`}
      accessibilityLiveRegion="polite"
      style={[styles.card, { borderColor: palette.accent, backgroundColor: palette.surface }]}
    >
      {ask.kind === "approval" ? (
        <>
          <Text style={[styles.small, { color: palette.textMuted }]}>{t("tool.approval")}</Text>
          <Text selectable style={[styles.summary, { color: palette.text }]}>
            {ask.summary}
          </Text>
          {ask.outside ? (
            <Text style={[styles.small, { color: palette.danger }]}>{t("tool.outside")}</Text>
          ) : null}
          {ask.sensitive ? (
            <Text style={[styles.small, { color: palette.danger }]}>{t("tool.sensitive")}</Text>
          ) : null}
          {allowDeny}
        </>
      ) : ask.kind === "article" ? (
        <>
          <Text style={[styles.body, { color: palette.text }]}>
            {t("tool.article", { title: ask.title })}
          </Text>
          {ask.after === null ? (
            <Text style={[styles.small, { color: palette.danger }]}>
              {t("tool.article.deleted")}
            </Text>
          ) : (
            <Text numberOfLines={8} selectable style={[styles.mono, { color: palette.text }]}>
              {ask.after}
            </Text>
          )}
          {allowDeny}
        </>
      ) : ask.kind === "question" ? (
        <>
          <Text selectable style={[styles.summary, { color: palette.text }]}>
            {ask.question}
          </Text>
          {ask.choices.length > 0 ? (
            <View style={styles.choices}>
              {ask.choices.map((choice) => (
                <Button
                  key={choice}
                  kind="secondary"
                  label={choice}
                  disabled={!online || busy}
                  onPress={() => void respond(choice)}
                />
              ))}
            </View>
          ) : null}
          <View style={styles.answerRow}>
            <TextInput
              testID="ask.answer"
              accessibilityLabel={t("tool.answer")}
              placeholder={t("tool.answer")}
              placeholderTextColor={palette.textMuted}
              value={answer}
              onChangeText={setAnswer}
              editable={online}
              style={[
                styles.input,
                {
                  color: palette.text,
                  borderColor: palette.border,
                  backgroundColor: palette.background,
                },
              ]}
            />
            <Button
              label={t("tool.answer.send")}
              disabled={!online || !answer.trim()}
              busy={busy}
              onPress={() => void respond(answer.trim())}
            />
          </View>
        </>
      ) : (
        <Text style={[styles.body, { color: palette.text }]}>
          {t("tool.secret", { name: view?.link.name ?? "" })}
        </Text>
      )}
      {askedAt ? <Text style={[styles.xs, { color: palette.textMuted }]}>{askedAt}</Text> : null}
      <ErrorLine text={error} />
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.l, padding: space.m, gap: space.s },
  small: { fontSize: text.s, lineHeight: 19 },
  xs: { fontSize: text.xs },
  body: { fontSize: text.m, lineHeight: 22 },
  summary: { fontSize: text.m, lineHeight: 22, fontWeight: "600" },
  mono: { fontFamily: "Menlo", fontSize: text.xs, lineHeight: 17 },
  buttons: { flexDirection: "row", gap: space.s },
  grow: { flex: 1 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
  answerRow: { flexDirection: "row", gap: space.s, alignItems: "center" },
  input: {
    flex: 1,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.m,
    paddingHorizontal: space.m,
    fontSize: text.m,
  },
})
