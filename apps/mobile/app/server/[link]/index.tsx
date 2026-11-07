import { router, Stack, useLocalSearchParams } from "expo-router"
import { useApp, useServer } from "../../../src/state/context.tsx"
import { Body, Button, Notice, Screen } from "../../../src/ui/kit.tsx"
import { stateText } from "../../../src/ui/states.ts"

/**
 * One paired computer (spec 011): its name and its connection state. The workflows of the computer
 * come to the phone in a later slice.
 */
export default function Server() {
  const { link } = useLocalSearchParams<{ link: string }>()
  const { t } = useApp()
  const view = useServer(link)
  if (!view) return <Screen>{null}</Screen>
  return (
    <>
      <Stack.Screen options={{ title: view.link.name }} />
      <Screen testID="server">
        {view.state === "not_allowed" ? (
          <>
            <Notice tone="danger" text={stateText(t, view)} />
            <Button label={t("servers.pairAgain")} onPress={() => router.push("/pair")} />
          </>
        ) : (
          <Notice text={stateText(t, view)} />
        )}
        <Body muted>{t("server.soon")}</Body>
      </Screen>
    </>
  )
}
