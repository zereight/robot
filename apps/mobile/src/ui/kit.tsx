import { type ReactNode, useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  RefreshControl,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native"
import { useApp } from "../state/context.tsx"
import { radius, space, text } from "../theme/palette.ts"

/** A scrolling screen with the colours of the theme and room for the keyboard. */
export const Screen = (props: {
  readonly children: ReactNode
  readonly testID?: string
  readonly padded?: boolean
  /** Pull to refresh. */
  readonly onRefresh?: () => Promise<unknown>
}) => {
  const { palette } = useApp()
  const [refreshing, setRefreshing] = useState(false)
  const refresh = props.onRefresh
  return (
    <ScrollView
      testID={props.testID}
      refreshControl={
        refresh ? (
          <RefreshControl
            refreshing={refreshing}
            tintColor={palette.textMuted}
            onRefresh={() => {
              setRefreshing(true)
              void refresh().finally(() => setRefreshing(false))
            }}
          />
        ) : undefined
      }
      style={{ backgroundColor: palette.background }}
      contentContainerStyle={props.padded === false ? undefined : styles.screen}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      {props.children}
    </ScrollView>
  )
}

export const Title = (props: { readonly children: ReactNode }) => {
  const { palette } = useApp()
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: palette.text }]}>
      {props.children}
    </Text>
  )
}

export const Body = (props: {
  readonly children: ReactNode
  readonly muted?: boolean
  readonly style?: StyleProp<TextStyle>
  readonly selectable?: boolean
}) => {
  const { palette } = useApp()
  return (
    <Text
      selectable={props.selectable}
      style={[styles.body, { color: props.muted ? palette.textMuted : palette.text }, props.style]}
    >
      {props.children}
    </Text>
  )
}

type ButtonKind = "primary" | "secondary" | "danger" | "plain"

export const Button = (
  props: {
    readonly label: string
    readonly kind?: ButtonKind
    readonly busy?: boolean
    readonly style?: StyleProp<ViewStyle>
  } & Omit<PressableProps, "style" | "children">,
) => {
  const { palette } = useApp()
  const { label, kind = "primary", busy, style, disabled, ...rest } = props
  const off = disabled || busy
  const background =
    kind === "primary" ? palette.accent : kind === "danger" ? palette.danger : "transparent"
  const colour =
    kind === "primary" || kind === "danger"
      ? palette.accentText
      : kind === "secondary"
        ? palette.text
        : palette.accent
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: kind === "secondary" ? palette.border : "transparent",
          opacity: off ? 0.5 : pressed ? 0.75 : 1,
        },
        style,
      ]}
      {...rest}
    >
      {busy ? <ActivityIndicator color={colour} style={styles.spinner} /> : null}
      <Text style={[styles.buttonText, { color: colour }]}>{label}</Text>
    </Pressable>
  )
}

export const Field = (
  props: { readonly label: string; readonly hint?: string } & TextInputProps,
) => {
  const { palette } = useApp()
  const { label, hint, style, ...rest } = props
  return (
    <View style={styles.field}>
      <Text
        testID={rest.testID ? `${rest.testID}.label` : undefined}
        style={[styles.label, { color: palette.text }]}
      >
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={palette.textMuted}
        style={[
          styles.input,
          { color: palette.text, backgroundColor: palette.surface, borderColor: palette.border },
          style,
        ]}
        {...rest}
      />
      {hint ? <Text style={[styles.hint, { color: palette.textMuted }]}>{hint}</Text> : null}
    </View>
  )
}

/** A plain line about a problem. It is read out when it shows. */
export const ErrorLine = (props: { readonly text: string | null; readonly testID?: string }) => {
  const { palette } = useApp()
  if (!props.text) return null
  return (
    <Text
      testID={props.testID}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[styles.body, { color: palette.danger }]}
    >
      {props.text}
    </Text>
  )
}

/** A muted box with one line, for "Offline" and other states. */
export const Notice = (props: { readonly text: string; readonly tone?: "muted" | "danger" }) => {
  const { palette } = useApp()
  return (
    <View
      style={[
        styles.notice,
        {
          backgroundColor: palette.surface,
          borderColor: props.tone === "danger" ? palette.danger : palette.border,
        },
      ]}
    >
      <Text
        style={[
          styles.small,
          { color: props.tone === "danger" ? palette.danger : palette.textMuted },
        ]}
      >
        {props.text}
      </Text>
    </View>
  )
}

export const Gap = (props: { readonly size?: keyof typeof space }) => (
  <View style={{ height: space[props.size ?? "m"] }} />
)

/** A text button for the header of a screen. */
export const HeaderButton = (props: {
  readonly label: string
  readonly onPress: () => void
  readonly testID?: string
}) => {
  const { palette } = useApp()
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={10}
      onPress={props.onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingHorizontal: space.xs })}
    >
      <Text style={{ color: palette.accent, fontSize: text.m, fontWeight: "600" }}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export const styles = StyleSheet.create({
  screen: { padding: space.l, gap: space.m },
  title: { fontSize: text.xl, fontWeight: "700" },
  body: { fontSize: text.m, lineHeight: 22 },
  small: { fontSize: text.s, lineHeight: 19 },
  button: {
    minHeight: 48,
    borderRadius: radius.m,
    paddingHorizontal: space.l,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    borderWidth: 1,
  },
  buttonText: { fontSize: text.m, fontWeight: "600" },
  spinner: { marginRight: space.s },
  field: { gap: space.xs },
  label: { fontSize: text.s, fontWeight: "600" },
  input: {
    minHeight: 48,
    borderRadius: radius.m,
    borderWidth: 1,
    paddingHorizontal: space.m,
    fontSize: text.m,
  },
  hint: { fontSize: text.xs, lineHeight: 17 },
  notice: { borderRadius: radius.m, borderWidth: 1, padding: space.m },
})
