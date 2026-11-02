import type { Face as FaceValue } from "@robot/shared"
import { Image } from "react-native"
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg"
import { faceColour } from "../theme/palette.ts"

const ink = "#1b1d23"

/** The features of one face shape, the same drawings as on the desktop (viewBox 64). */
const Features = ({ shape }: { readonly shape: number }) => {
  const line = { stroke: ink, strokeWidth: 3, strokeLinecap: "round" as const, fill: "none" }
  switch (shape) {
    case 0:
      return (
        <G>
          <Circle cx="24" cy="28" r="4" fill={ink} />
          <Circle cx="40" cy="28" r="4" fill={ink} />
          <Path d="M23 39 Q32 47 41 39" {...line} />
        </G>
      )
    case 1:
      return (
        <G>
          <Ellipse cx="24" cy="28" rx="3" ry="5.5" fill={ink} />
          <Ellipse cx="40" cy="28" rx="3" ry="5.5" fill={ink} />
          <Path d="M26 42 H38" {...line} />
        </G>
      )
    case 2:
      return (
        <G>
          <Rect x="15" y="22" width="34" height="12" rx="6" fill={ink} />
          <Circle cx="24" cy="28" r="2.5" fill="#fff" />
          <Circle cx="40" cy="28" r="2.5" fill="#fff" />
          <Path d="M28 43 H36" {...line} />
        </G>
      )
    case 3:
      return (
        <G>
          <Circle cx="32" cy="29" r="8" fill={ink} />
          <Circle cx="34.5" cy="26.5" r="2.5" fill="#fff" />
          <Path d="M26 43 Q32 47 38 43" {...line} />
        </G>
      )
    case 4:
      return (
        <G>
          <Path d="M19 30 Q24 25 29 30" {...line} />
          <Path d="M35 30 Q40 25 45 30" {...line} />
          <Circle cx="32" cy="42" r="3" fill={ink} />
        </G>
      )
    default:
      return (
        <G>
          <Path d="M32 6 V14" {...line} />
          <Circle cx="32" cy="7" r="3" fill={ink} />
          <Rect x="20" y="25" width="7" height="7" rx="1.5" fill={ink} />
          <Rect x="37" y="25" width="7" height="7" rx="1.5" fill={ink} />
          <Path d="M24 41 Q32 46 40 41" {...line} />
        </G>
      )
  }
}

/** A round agent face: the uploaded picture, or the drawn character in its hue. */
export const Face = (props: {
  readonly face: FaceValue | null | undefined
  readonly image?: string | null | undefined
  readonly size: number
  readonly label?: string | undefined
}) => {
  if (props.image?.startsWith("data:image/")) {
    return (
      <Image
        source={{ uri: props.image }}
        {...(props.label ? { accessibilityLabel: props.label } : {})}
        accessibilityElementsHidden={!props.label}
        style={{ width: props.size, height: props.size, borderRadius: props.size / 2 }}
      />
    )
  }
  const face = props.face ?? { shape: 0, hue: 0 }
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 64 64"
      {...(props.label ? { accessibilityLabel: props.label } : {})}
      accessibilityElementsHidden={!props.label}
      importantForAccessibility={props.label ? "yes" : "no-hide-descendants"}
    >
      <Circle cx="32" cy="32" r="32" fill={faceColour(face.hue)} />
      <Features shape={face.shape} />
    </Svg>
  )
}
