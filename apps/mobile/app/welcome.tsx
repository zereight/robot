import { DEVICE_NAME_MAX } from "@robot/link"
import { router } from "expo-router"
import { useState } from "react"
import { useApp } from "../src/state/context.tsx"
import { Body, Button, ErrorLine, Field, Gap, Notice, Screen, Title } from "../src/ui/kit.tsx"

/** First start (spec 011): the name that computers show for this phone, then the camera. */
export default function Welcome() {
  const { hub, t, errorLine } = useApp()
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await hub.setDeviceName(name)
      router.replace("/")
      router.push("/pair")
    } catch (e) {
      setError(errorLine(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen testID="welcome">
      <Gap size="xl" />
      <Title>{t("welcome.title")}</Title>
      <Body muted>{t("welcome.body")}</Body>
      <Gap />
      <Field
        testID="welcome.name"
        label={t("welcome.name.label")}
        hint={t("welcome.name.hint")}
        placeholder={t("welcome.name.placeholder")}
        value={name}
        onChangeText={setName}
        maxLength={DEVICE_NAME_MAX}
        autoFocus
        autoCorrect={false}
        returnKeyType="next"
        onSubmitEditing={save}
      />
      <ErrorLine text={error} />
      <Notice text={t("welcome.localNetwork")} />
      <Button
        testID="welcome.continue"
        label={t("common.continue")}
        busy={busy}
        disabled={!name.trim()}
        onPress={save}
      />
    </Screen>
  )
}
