import {
  type FaceLayer,
  type FacePart,
  type Face as FaceValue,
  faceLayers,
  facePaint,
  faceParts,
  faceTones,
} from "@robot/shared"
import type { ComponentType } from "react"
import { Image } from "react-native"
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg"
import { useApp } from "../state/context.tsx"

const tags: Record<FacePart["tag"], ComponentType<Record<string, unknown>>> = {
  circle: Circle as ComponentType<Record<string, unknown>>,
  ellipse: Ellipse as ComponentType<Record<string, unknown>>,
  rect: Rect as ComponentType<Record<string, unknown>>,
  path: Path as ComponentType<Record<string, unknown>>,
}

/**
 * One layer of the light of a face: the features of a shape in one colour. The sharp core is the
 * top layer. Under it lie wider, fainter layers: together they are the glow, the same drawing as
 * on the desktop. A layer does not use a blur filter, so it looks the same on every phone and
 * stays cheap in a long list.
 */
const Layer = ({ shape, layer }: { readonly shape: number; readonly layer: FaceLayer }) => (
  <G>
    {faceParts(shape).map((part, index) => {
      const Tag = tags[part.tag]
      // The parts of a shape never change order, so the place in the list is a steady key.
      // biome-ignore lint/suspicious/noArrayIndexKey: see above
      return <Tag key={index} {...part.geometry} {...facePaint(part, layer)} />
    })}
  </G>
)

/**
 * A round agent face: the uploaded picture, or a drawn character in its hue. In the dark theme it
 * glows, like the app mark. In the light theme it has dark features and no glow. A picture has the
 * same rim.
 */
export const Face = (props: {
  readonly face: FaceValue | null | undefined
  readonly image?: string | null | undefined
  readonly size: number
  readonly label?: string | undefined
}) => {
  const { scheme } = useApp()
  const face = props.face ?? { shape: 0, hue: 0 }
  const tones = faceTones(face.hue, scheme)
  if (props.image?.startsWith("data:image/")) {
    return (
      <Image
        source={{ uri: props.image }}
        {...(props.label ? { accessibilityLabel: props.label } : {})}
        accessibilityElementsHidden={!props.label}
        style={{
          width: props.size,
          height: props.size,
          borderRadius: props.size / 2,
          borderWidth: 1.5,
          borderColor: tones.ring,
        }}
      />
    )
  }
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 64 64"
      {...(props.label ? { accessibilityLabel: props.label } : {})}
      accessibilityElementsHidden={!props.label}
      importantForAccessibility={props.label ? "yes" : "no-hide-descendants"}
    >
      <Circle cx="32" cy="32" r="32" fill={tones.tile} />
      {/* A thin rim, so that the disc keeps its shape on a surface of its own tone. */}
      <Circle cx="32" cy="32" r="31.25" fill="none" stroke={tones.ring} strokeWidth={1.5} />
      {faceLayers(face.hue, props.size, scheme).map((layer) => (
        <Layer key={layer.grow} shape={face.shape} layer={layer} />
      ))}
    </Svg>
  )
}
