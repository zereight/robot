import { StyleSheet, Text, View } from "react-native"
import { mark } from "../theme/palette.ts"

/**
 * A round mark in the family of the app mark: a very dark disc, a thin rim of light, and a glyph
 * of light on it. The user has one, and a channel has one in place of a face. The glow of the
 * glyph is a text shadow, so it needs no filter.
 */
export const AvatarMark = (props: { readonly glyph: string; readonly size: number }) => (
  <View
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    style={[styles.disc, { width: props.size, height: props.size, borderRadius: props.size / 2 }]}
  >
    <Text style={[styles.glyph, { fontSize: Math.round(props.size * 0.46) }]}>{props.glyph}</Text>
  </View>
)

const styles = StyleSheet.create({
  disc: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: mark.tile,
    borderWidth: 1.5,
    borderColor: "rgba(122, 255, 212, 0.4)",
  },
  glyph: {
    color: mark.eyes,
    fontWeight: "600",
    textShadowColor: mark.glow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
})
