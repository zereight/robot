import { LinkError } from "@robot/link"
import type { PairRun } from "@robot/phone"
import { CameraView, useCameraPermissions } from "expo-camera"
import { router } from "expo-router"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Linking, StyleSheet, View } from "react-native"
import { useApp } from "../src/state/context.tsx"
import { radius, space } from "../src/theme/palette.ts"
import { Body, Button, ErrorLine, Field, Notice, Screen, Title } from "../src/ui/kit.tsx"

type Phase =
  | { readonly kind: "form" }
  | { readonly kind: "checking" }
  | { readonly kind: "waiting"; readonly name: string }

/** Pairing on the phone (spec 011): the QR code, or the address and the code typed in. */
export default function Pair() {
  const { hub, t, palette, errorLine } = useApp()
  const [permission, askPermission] = useCameraPermissions()
  const [mode, setMode] = useState<"scan" | "type">("scan")
  const [phase, setPhase] = useState<Phase>({ kind: "form" })
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState("")
  const [code, setCode] = useState("")
  const run = useRef<PairRun | null>(null)

  // Leaving the screen ends a pairing that still runs.
  useEffect(() => () => run.current?.cancel(), [])

  const start = (input: { link: string } | { address: string; code: string }) => {
    if (run.current) return
    setError(null)
    setPhase({ kind: "checking" })
    const current = hub.pair(input, (name) => setPhase({ kind: "waiting", name }))
    run.current = current
    current.done.then(
      (link) => {
        run.current = null
        void link
        router.back()
      },
      (e: unknown) => {
        run.current = null
        setPhase({ kind: "form" })
        if (e instanceof LinkError && e.code === "cancelled") return
        setError(errorLine(e))
      },
    )
  }

  const cancel = () => {
    run.current?.cancel()
    run.current = null
    setPhase({ kind: "form" })
  }

  if (phase.kind !== "form") {
    return (
      <Screen testID="pair.busy">
        <View style={styles.centre}>
          <ActivityIndicator size="large" color={palette.accent} />
          <Title>
            {phase.kind === "waiting"
              ? t("pair.waiting", { name: phase.name })
              : t("pair.checking")}
          </Title>
          {phase.kind === "waiting" ? (
            <Body muted>{t("pair.waiting.hint", { name: phase.name })}</Body>
          ) : null}
          <Button kind="secondary" label={t("common.cancel")} onPress={cancel} />
        </View>
      </Screen>
    )
  }

  const scanner =
    permission?.granted === true ? (
      <View style={[styles.camera, { borderColor: palette.border }]}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(result) => {
            if (!run.current) start({ link: result.data })
          }}
        />
      </View>
    ) : permission && !permission.canAskAgain ? (
      <>
        <Notice text={t("pair.camera.denied")} />
        <Button
          kind="secondary"
          label={t("common.openSettings")}
          onPress={() => Linking.openSettings()}
        />
      </>
    ) : (
      <>
        <Body muted>{t("pair.camera.ask")}</Body>
        <Button label={t("pair.camera.allow")} onPress={() => void askPermission()} />
      </>
    )

  return (
    <Screen testID="pair">
      {mode === "scan" ? (
        <>
          <Body>{t("pair.scan.hint")}</Body>
          {scanner}
          <ErrorLine testID="pair.error" text={error} />
          <Button
            testID="pair.typeInstead"
            kind="plain"
            label={t("pair.typeInstead")}
            onPress={() => {
              setError(null)
              setMode("type")
            }}
          />
        </>
      ) : (
        <>
          <Field
            testID="pair.address"
            label={t("pair.address.label")}
            hint={t("pair.address.hint")}
            placeholder={t("pair.address.placeholder")}
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            textContentType="URL"
            returnKeyType="next"
          />
          <Field
            testID="pair.code"
            label={t("pair.code.label")}
            placeholder={t("pair.code.placeholder")}
            value={code}
            onChangeText={(v) => setCode(v.replace(/[^\d ]/g, "").slice(0, 7))}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            maxLength={7}
          />
          <ErrorLine testID="pair.error" text={error} />
          <Button
            testID="pair.submit"
            label={t("pair.submit")}
            disabled={!address.trim() || code.replace(/\s/g, "").length !== 6}
            onPress={() => start({ address, code })}
          />
          <Button
            kind="plain"
            label={t("pair.scanInstead")}
            onPress={() => {
              setError(null)
              setMode("scan")
            }}
          />
        </>
      )}
      <Notice text={t("pair.localNetwork")} />
      <Body muted style={styles.small}>
        {t("pair.vpn")}
      </Body>
    </Screen>
  )
}

const styles = StyleSheet.create({
  centre: { alignItems: "center", gap: space.l, paddingTop: space.xl * 2 },
  camera: {
    aspectRatio: 1,
    borderRadius: radius.l,
    overflow: "hidden",
    borderWidth: 1,
  },
  small: { fontSize: 14 },
})
