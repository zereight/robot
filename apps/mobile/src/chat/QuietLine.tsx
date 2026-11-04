import { type QuietTurn, quietShown } from "@robot/shared"
import { useEffect, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { useApp } from "../state/context.tsx"
import { space, text } from "../theme/palette.ts"

/**
 * The quiet line of a chat (spec 005, "Quiet line"; 011): "No answer from <name> for <time>". It
 * shows while the turn of the open place shows no sign of life. The server pushes the start and the
 * end with the seconds at that moment; the phone counts on once each second. It makes no sound and
 * no notification, and it is not stored.
 */
export function QuietLine(props: { turn: QuietTurn; receivedAt: number }) {
  const { t, palette } = useApp()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const shown = quietShown(props.turn, props.receivedAt, now)
  return (
    <View style={styles.line} testID="quiet-line">
      <Text style={{ color: palette.textMuted, fontSize: text.s }}>
        {t("chat.quiet", { name: shown.name, time: shown.time })}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  line: { paddingHorizontal: space.l, paddingVertical: space.s },
})
