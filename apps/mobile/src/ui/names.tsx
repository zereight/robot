import { phoneShownName } from "@robot/phone"
import type { ShownName } from "@robot/shared"
import { useCallback } from "react"
import { type StyleProp, Text, type TextStyle } from "react-native"
import { useApp, useServer } from "../state/context.tsx"

/**
 * The name of an agent as the phone shows it (spec 036, 011): the organization prefix, muted, then
 * the stored name. The switch is the one of this phone, and the organization names are the ones
 * that the phone holds for the server (from the cache while the server is offline).
 */
export const useShownName = (linkId: string) => {
  const { prefs } = useApp()
  const orgs = useServer(linkId)?.data.agentOrgs
  const on = prefs.showOrgPrefix
  return useCallback(
    (agentId: string | null | undefined, name: string): ShownName =>
      phoneShownName(orgs, on, agentId ?? "", name),
    [orgs, on],
  )
}

/**
 * The shown name as a `Text`: a muted prefix, a space and the name. The name keeps the style that
 * the caller gives. The accessible name is `shown.label` (spec 036).
 */
export const ShownText = (props: {
  readonly shown: ShownName
  readonly style?: StyleProp<TextStyle>
  readonly numberOfLines?: number
  readonly testID?: string
}) => {
  const { palette } = useApp()
  const { prefix, name, label } = props.shown
  return (
    <Text
      testID={props.testID}
      numberOfLines={props.numberOfLines}
      style={props.style}
      accessibilityLabel={prefix === null ? undefined : label}
    >
      {prefix === null ? (
        name
      ) : (
        <>
          <Text style={{ color: palette.textMuted, fontWeight: "400" }}>{prefix}</Text>
          {` ${name}`}
        </>
      )}
    </Text>
  )
}
