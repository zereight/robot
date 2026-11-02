import type { Face as FaceValue } from "@robot/shared"
import { createEffect, type JSX, Match, on, onMount, Show, Switch } from "solid-js"
import { motionMs } from "../ui/Presence.tsx"
import styles from "./face.module.css"
import { bornRecently, type Reaction, reactions } from "./reactions.ts"

const ink = "#1b1d23"

/** Background colour of a face: ten hues, light enough for dark features. */
export const faceColour = (hue: number) => `hsl(${hue * 36} 58% 64%)`

/** The features of one shape. The eyes are one group, so a blink can close them. */
const Features = (props: { shape: number }): JSX.Element => (
  <Switch>
    <Match when={props.shape === 0}>
      <g class={styles.eyes} data-part="eyes">
        <circle cx="24" cy="28" r="4" fill={ink} />
        <circle cx="40" cy="28" r="4" fill={ink} />
      </g>
      <path
        d="M23 39 Q32 47 41 39"
        stroke={ink}
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
      />
    </Match>
    <Match when={props.shape === 1}>
      <g class={styles.eyes} data-part="eyes">
        <ellipse cx="24" cy="28" rx="3" ry="5.5" fill={ink} />
        <ellipse cx="40" cy="28" rx="3" ry="5.5" fill={ink} />
      </g>
      <path d="M26 42 H38" stroke={ink} stroke-width="3" stroke-linecap="round" />
    </Match>
    <Match when={props.shape === 2}>
      <g class={styles.eyes} data-part="eyes">
        <rect x="15" y="22" width="34" height="12" rx="6" fill={ink} />
        <circle cx="24" cy="28" r="2.5" fill="#fff" />
        <circle cx="40" cy="28" r="2.5" fill="#fff" />
      </g>
      <path d="M28 43 H36" stroke={ink} stroke-width="3" stroke-linecap="round" />
    </Match>
    <Match when={props.shape === 3}>
      <g class={styles.eyes} data-part="eyes">
        <circle cx="32" cy="29" r="8" fill={ink} />
        <circle cx="34.5" cy="26.5" r="2.5" fill="#fff" />
      </g>
      <path
        d="M26 43 Q32 47 38 43"
        stroke={ink}
        stroke-width="3"
        fill="none"
        stroke-linecap="round"
      />
    </Match>
    <Match when={props.shape === 4}>
      {/* These eyes are already closed, so this shape does not blink. */}
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
      <g class={styles.eyes} data-part="eyes">
        <rect x="20" y="25" width="7" height="7" rx="1.5" fill={ink} />
        <rect x="37" y="25" width="7" height="7" rx="1.5" fill={ink} />
      </g>
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

const OUT = "cubic-bezier(0.23, 1, 0.32, 1)"
const IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)"

/** One blink: the lids close in 100 ms and open slower, 170 ms. */
const blink = (root: Element, delay = 0) => {
  const eyes = root.querySelector("[data-part=eyes]")
  eyes?.animate(
    [
      { transform: "scaleY(1)", easing: IN_OUT },
      { transform: "scaleY(0.1)", offset: 0.37, easing: OUT },
      { transform: "scaleY(1)" },
    ],
    { duration: 270, delay },
  )
}

/**
 * Plays one reaction on a face. Each motion ends by itself in under 300 ms, and nothing plays
 * when reduce motion is on (the motion tokens are 0 then).
 */
const play = (root: Element, kind: Reaction | "land") => {
  if (motionMs("fast") === 0) return
  if (kind === "failed") {
    root.animate(
      [
        { transform: "translateX(0)" },
        { transform: "translateX(-7%)", offset: 0.25 },
        { transform: "translateX(7%)", offset: 0.55 },
        { transform: "translateX(-4%)", offset: 0.8 },
        { transform: "translateX(0)" },
      ],
      { duration: 240, easing: OUT },
    )
    return
  }
  if (kind === "land") {
    root.animate(
      [
        { transform: "translateY(-30%) scale(0.92)", opacity: 0 },
        { transform: "translateY(0) scale(1)", opacity: 1 },
      ],
      { duration: 260, easing: OUT },
    )
    blink(root, 260)
    return
  }
  root.animate(
    [
      { transform: "translateY(0)" },
      { transform: "translateY(-8%)", offset: 0.4 },
      { transform: "translateY(0)" },
    ],
    { duration: 160, easing: OUT },
  )
  if (kind === "done") blink(root)
}

/**
 * A round agent face: an uploaded picture, or a drawn character in one of ten hues.
 * With `agentId` the face reacts once when that agent ends a reply, fails, or asks the user.
 * With `swap` a new shape comes in softly (for the preview in the agent form).
 */
export const Face = (props: {
  face: FaceValue
  image?: string | null
  size: number
  label?: string
  agentId?: string
  swap?: boolean
}) => {
  let root: Element | undefined
  const mark = (el: Element) => {
    root = el
  }

  createEffect(
    on(
      () => (props.agentId ? reactions[props.agentId]?.n : undefined),
      (n, previous) => {
        const id = props.agentId
        if (!id || n === undefined || n === previous || !root) return
        const kind = reactions[id]?.kind
        if (kind) play(root, kind)
      },
      { defer: true },
    ),
  )
  onMount(() => {
    const id = props.agentId
    if (id && bornRecently(id)) queueMicrotask(() => root && play(root, "land"))
  })

  return (
    <Show
      when={props.image}
      fallback={
        <svg
          ref={mark}
          class={styles.face}
          width={props.size}
          height={props.size}
          viewBox="0 0 64 64"
          role="img"
          aria-label={props.label}
          aria-hidden={props.label ? undefined : "true"}
          data-face-shape={props.face.shape}
          data-face-hue={props.face.hue}
        >
          <circle
            class={styles.skin}
            cx="32"
            cy="32"
            r="32"
            style={{ fill: faceColour(props.face.hue) }}
          />
          <Show when={props.face.shape} keyed>
            {(shape) => (
              <g class={props.swap ? styles.swap : undefined}>
                <Features shape={shape} />
              </g>
            )}
          </Show>
        </svg>
      }
    >
      {(image) => (
        <img
          ref={mark}
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
}
