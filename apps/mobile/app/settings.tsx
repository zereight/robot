import { DEVICE_NAME_MAX } from "@robot/link"
import * as Notifications from "expo-notifications"
import { type ReactNode, useEffect, useState } from "react"
import { Linking, Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native"
import type { MessageKey } from "../src/i18n/index.ts"
import { forgetDownloads } from "../src/platform/files.ts"
import { forgetServer, NOTIFY_KINDS, type Prefs } from "../src/prefs.ts"
import { useApp, useHubState } from "../src/state/context.tsx"
import { radius, space, text } from "../src/theme/palette.ts"
import { Body, Button, ErrorLine, Field, Notice, Screen } from "../src/ui/kit.tsx"
import { Sheet } from "../src/ui/Sheet.tsx"

/** Settings (spec 011): language, theme, notifications, unpair, and the name of this phone. */
export default function Settings() {
  const { hub, t, prefs, setPrefs, errorLine } = useApp()
  const state = useHubState()
  const [name, setName] = useState(state.deviceName ?? "")
  const [nameError, setNameError] = useState<string | null>(null)
  const [unpair, setUnpair] = useState<{ id: string; name: string } | null>(null)
  const [allowed, setAllowed] = useState<boolean | null>(null)

  useEffect(() => {
    void Notifications.getPermissionsAsync().then((p) => setAllowed(p.status !== "denied"))
  }, [])

  const saveName = async () => {
    setNameError(null)
    try {
      await hub.setDeviceName(name)
    } catch (e) {
      setNameError(errorLine(e))
    }
  }

  return (
    <Screen testID="settings">
      <Section title={t("settings.device")}>
        <Field
          testID="settings.name"
          label={t("welcome.name.label")}
          hint={t("settings.device.hint")}
          value={name}
          onChangeText={setName}
          onEndEditing={saveName}
          onSubmitEditing={saveName}
          maxLength={DEVICE_NAME_MAX}
          autoCorrect={false}
          returnKeyType="done"
        />
        <ErrorLine text={nameError} />
      </Section>

      <Section title={t("settings.language")}>
        <Choices<Prefs["language"]>
          value={prefs.language}
          options={[
            ["system", "settings.language.system"],
            ["en", "settings.language.en"],
            ["ko", "settings.language.ko"],
          ]}
          onChange={(language) => setPrefs((p) => ({ ...p, language }))}
        />
      </Section>

      <Section title={t("settings.theme")}>
        <Choices<Prefs["theme"]>
          value={prefs.theme}
          options={[
            ["system", "settings.theme.system"],
            ["dark", "settings.theme.dark"],
            ["light", "settings.theme.light"],
          ]}
          onChange={(theme) => setPrefs((p) => ({ ...p, theme }))}
        />
      </Section>

      <Section title={t("settings.chat")}>
        <Toggle
          testID="settings.showToolSteps"
          label={t("settings.showToolSteps")}
          value={prefs.showToolSteps}
          onChange={(showToolSteps) => setPrefs((p) => ({ ...p, showToolSteps }))}
        />
      </Section>

      <Section title={t("settings.notifications")}>
        <Body muted style={styles.small}>
          {Platform.OS === "ios"
            ? t("settings.notify.line.ios")
            : t("settings.notify.line.android")}
        </Body>
        {allowed === false ? (
          <>
            <Notice tone="danger" text={t("settings.notify.denied")} />
            <Button
              kind="secondary"
              label={t("common.openSettings")}
              onPress={() => void Linking.openSettings()}
            />
          </>
        ) : null}
        {NOTIFY_KINDS.map((kind) => (
          <Toggle
            key={kind}
            testID={`settings.notify.${kind}`}
            label={t(`settings.notify.${kind}` as MessageKey)}
            value={prefs.notify[kind]}
            onChange={(on) => setPrefs((p) => ({ ...p, notify: { ...p.notify, [kind]: on } }))}
          />
        ))}
      </Section>

      <Section title={t("settings.servers")}>
        {state.servers.length === 0 ? <Body muted>{t("settings.servers.empty")}</Body> : null}
        {state.servers.map((s) => (
          <View key={s.link.id} style={styles.serverRow}>
            <Body style={styles.grow}>{s.link.name}</Body>
            <Button
              testID={`settings.unpair.${s.link.name}`}
              kind="plain"
              label={t("settings.unpair")}
              onPress={() => setUnpair({ id: s.link.id, name: s.link.name })}
            />
          </View>
        ))}
      </Section>

      <Sheet
        visible={unpair !== null}
        onClose={() => setUnpair(null)}
        title={unpair ? t("settings.unpair.title", { name: unpair.name }) : ""}
        actions={
          unpair
            ? [
                {
                  label: t("settings.unpair"),
                  danger: true,
                  testID: "settings.unpair.confirm",
                  onPress: () => {
                    const id = unpair.id
                    void hub.unpair(id).then(() => {
                      forgetDownloads(id)
                      setPrefs((p) => forgetServer(p, id))
                    })
                  },
                },
              ]
            : []
        }
      >
        {unpair ? <Body>{t("settings.unpair.body", { name: unpair.name })}</Body> : null}
      </Sheet>
    </Screen>
  )
}

const Section = (props: { readonly title: string; readonly children: ReactNode }) => {
  const { palette } = useApp()
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: palette.textMuted }]}>
        {props.title}
      </Text>
      <View
        style={[styles.group, { backgroundColor: palette.surface, borderColor: palette.border }]}
      >
        {props.children}
      </View>
    </View>
  )
}

const Choices = <T extends string>(props: {
  readonly value: T
  readonly options: readonly (readonly [T, MessageKey])[]
  readonly onChange: (value: T) => void
}) => {
  const { t, palette } = useApp()
  return (
    <View accessibilityRole="radiogroup">
      {props.options.map(([value, key]) => {
        const on = props.value === value
        return (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => props.onChange(value)}
            style={({ pressed }) => [styles.option, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.optionText, { color: palette.text }]}>{t(key)}</Text>
            {on ? <Text style={{ color: palette.accent, fontSize: text.m }}>✓</Text> : null}
          </Pressable>
        )
      })}
    </View>
  )
}

const Toggle = (props: {
  readonly label: string
  readonly value: boolean
  readonly onChange: (on: boolean) => void
  readonly testID?: string
}) => {
  const { palette } = useApp()
  return (
    <View style={styles.option}>
      <Text style={[styles.optionText, { color: palette.text }]}>{props.label}</Text>
      <Switch
        {...(props.testID ? { testID: props.testID } : {})}
        accessibilityLabel={props.label}
        value={props.value}
        onValueChange={props.onChange}
        trackColor={{ true: palette.accent, false: palette.border }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  section: { gap: space.xs },
  sectionTitle: { fontSize: text.s, fontWeight: "600", paddingHorizontal: space.xs },
  group: { borderWidth: 1, borderRadius: radius.l, padding: space.m, gap: space.s },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
    gap: space.m,
  },
  optionText: { flex: 1, fontSize: text.m },
  serverRow: { flexDirection: "row", alignItems: "center", gap: space.s },
  grow: { flex: 1 },
  small: { fontSize: text.s },
})
