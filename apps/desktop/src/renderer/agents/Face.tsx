import type { Face as FaceValue } from "@robot/shared"
import { type JSX, Match, Show, Switch } from "solid-js"

const ink = "#1b1d23"

/** Background colour of a face: ten hues, light enough for dark features. */
export const faceColour = (hue: number) => `hsl(${hue * 36} 58% 64%)`

const Features = (props: { shape: number }): JSX.Element => (
  <Switch>
    <Match when={props.shape === 0}>
      <circle cx="24" cy="28" r="4" fill={ink} />
      <circle cx="40" cy="28" r="4" fill={ink} />
      <path
        d="M23 39 Q32 47 41 39"
        stroke={ink}
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
      />
    </Match>
    <Match when={props.shape === 1}>
      <ellipse cx="24" cy="28" rx="3" ry="5.5" fill={ink} />
      <ellipse cx="40" cy="28" rx="3" ry="5.5" fill={ink} />
      <path d="M26 42 H38" stroke={ink} stroke-width="3" stroke-linecap="round" />
    </Match>
    <Match when={props.shape === 2}>
      <rect x="15" y="22" width="34" height="12" rx="6" fill={ink} />
      <circle cx="24" cy="28" r="2.5" fill="#fff" />
      <circle cx="40" cy="28" r="2.5" fill="#fff" />
      <path d="M28 43 H36" stroke={ink} stroke-width="3" stroke-linecap="round" />
    </Match>
    <Match when={props.shape === 3}>
      <circle cx="32" cy="29" r="8" fill={ink} />
      <circle cx="34.5" cy="26.5" r="2.5" fill="#fff" />
      <path
        d="M26 43 Q32 47 38 43"
        stroke={ink}
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
      />
    </Match>
    <Match when={props.shape === 4}>
      <path
        d="M19 30 Q24 25 29 30"
        stroke={ink}
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
      />
      <path
        d="M35 30 Q40 25 45 30"
        stroke={ink}
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
      />
      <circle cx="32" cy="42" r="3" fill={ink} />
    </Match>
    <Match when={true}>
      <path d="M32 6 V14" stroke={ink} stroke-width="3" stroke-linecap="round" />
      <circle cx="32" cy="7" r="3" fill={ink} />
      <rect x="20" y="25" width="7" height="7" rx="1.5" fill={ink} />
      <rect x="37" y="25" width="7" height="7" rx="1.5" fill={ink} />
      <path
        d="M24 41 Q32 46 40 41"
        stroke={ink}
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
      />
    </Match>
  </Switch>
)

/** A round agent face: an uploaded picture, or a drawn character in one of ten hues. */
export const Face = (props: {
  face: FaceValue
  image?: string | null
  size: number
  label?: string
}) => (
  <Show
    when={props.image}
    fallback={
      <svg
        width={props.size}
        height={props.size}
        viewBox="0 0 64 64"
        role="img"
        aria-label={props.label}
        aria-hidden={props.label ? undefined : "true"}
        data-face-shape={props.face.shape}
        data-face-hue={props.face.hue}
        style={{ "flex-shrink": 0, display: "block" }}
      >
        <circle cx="32" cy="32" r="32" fill={faceColour(props.face.hue)} />
        <Features shape={props.face.shape} />
      </svg>
    }
  >
    {(image) => (
      <img
        src={image()}
        width={props.size}
        height={props.size}
        alt={props.label ?? ""}
        style={{
          "border-radius": "50%",
          "object-fit": "cover",
          "flex-shrink": 0,
          display: "block",
        }}
      />
    )}
  </Show>
)
