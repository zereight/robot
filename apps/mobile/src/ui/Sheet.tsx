import type { ReactNode } from "react"
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useApp } from "../state/context.tsx"
import { radius, space, text } from "../theme/palette.ts"

export interface SheetAction {
  readonly label: string
  readonly onPress: () => void
  readonly danger?: boolean
  readonly testID?: string
}

/** A bottom sheet (spec 011, "bottom sheets for menus"): a title, content, and actions. */
export const Sheet = (props: {
  readonly visible: boolean
  readonly onClose: () => void
  readonly title?: string
  readonly actions?: readonly SheetAction[]
  readonly children?: ReactNode
  readonly tall?: boolean
}) => {
  const { t, palette } = useApp()
  const insets = useSafeAreaInsets()
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      <View style={styles.root}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={props.onClose}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            props.tall ? styles.tall : undefined,
            { backgroundColor: palette.elevated, paddingBottom: insets.bottom + space.m },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: palette.border }]} />
          {props.title ? (
            <Text accessibilityRole="header" style={[styles.title, { color: palette.text }]}>
              {props.title}
            </Text>
          ) : null}
          {props.children ? (
            <ScrollView style={styles.content} contentContainerStyle={{ gap: space.m }}>
              {props.children}
            </ScrollView>
          ) : null}
          {(props.actions ?? []).map((action) => (
            <Pressable
              key={action.label}
              testID={action.testID}
              accessibilityRole="button"
              onPress={() => {
                props.onClose()
                action.onPress()
              }}
              style={({ pressed }) => [
                styles.action,
                { backgroundColor: pressed ? palette.pressed : "transparent" },
              ]}
            >
              <Text
                style={[
                  styles.actionText,
                  { color: action.danger ? palette.danger : palette.text },
                ]}
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            style={({ pressed }) => [
              styles.action,
              { backgroundColor: pressed ? palette.pressed : "transparent" },
            ]}
          >
            <Text style={[styles.actionText, { color: palette.accent, fontWeight: "600" }]}>
              {props.actions ? t("common.cancel") : t("common.close")}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    borderTopLeftRadius: radius.l * 1.5,
    borderTopRightRadius: radius.l * 1.5,
    paddingHorizontal: space.l,
    paddingTop: space.s,
    gap: space.xs,
    maxHeight: "85%",
  },
  tall: { minHeight: "60%" },
  grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, marginBottom: space.s },
  title: { fontSize: text.l, fontWeight: "700", paddingVertical: space.s },
  content: { flexGrow: 0 },
  action: {
    minHeight: 50,
    justifyContent: "center",
    paddingHorizontal: space.s,
    borderRadius: radius.m,
  },
  actionText: { fontSize: text.m },
})
