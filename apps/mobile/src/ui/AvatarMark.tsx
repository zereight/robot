import { StyleSheet, Text, View } from "react-native"
import { useApp } from "../state/context.tsx"

/**
 * A round mark in the family of the faces. In the dark theme it is a very dark disc with a thin
 * rim of light and a glyph of light, as the app mark is. In the light theme it is a light disc
 * with a dark glyph and no glow. The user has one, and a channel has one in place of a face. The
 * glow of the glyph is a text shadow, so it needs no filter.
 */
export const AvatarMark = (props: { readonly glyph: string; readonly size: number }) => {
  const { palette, scheme } = useApp()
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.disc,
        {
          width: props.size,
          height: props.size,
          borderRadius: props.size / 2,
          backgroundColor: palette.avatarTile,
          borderColor: palette.avatarRim,
        },
      ]}
    >
      <Text
        style={[
          styles.glyph,
          { fontSize: Math.round(props.size * 0.46), color: palette.avatarGlyph },
          scheme === "dark" ? { textShadowColor: palette.avatarGlow, textShadowRadius: 6 } : null,
        ]}
      >
        {props.glyph}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  disc: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
  glyph: {
    fontWeight: "600",
    textShadowOffset: { width: 0, height: 0 },
  },
})
