import { Image } from "react-native"
import { useApp } from "../state/context.tsx"
import { AvatarMark } from "./AvatarMark.tsx"

/**
 * The mark of a channel (spec 004, "Picture"; 011): its picture when it has one, round and with
 * the thin rim of an avatar, or the mark with the `#`. The picture does not change with the theme.
 * The name stands next to the mark, so the picture has no text of its own.
 */
export const ChannelMark = (props: {
  readonly picture: string | null | undefined
  readonly size: number
}) => {
  const { palette } = useApp()
  if (!props.picture?.startsWith("data:image/")) return <AvatarMark glyph="#" size={props.size} />
  return (
    <Image
      source={{ uri: props.picture }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: props.size,
        height: props.size,
        borderRadius: props.size / 2,
        borderWidth: 1.5,
        borderColor: palette.avatarRim,
      }}
    />
  )
}
