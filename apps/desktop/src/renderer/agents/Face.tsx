import {
  type FaceLayer,
  type FacePart,
  type Face as FaceValue,
  faceLayers,
  facePaint,
  faceParts,
  faceTones,
} from "@robot/shared"
import { createEffect, For, Index, on, onMount, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { motionMs } from "../ui/Presence.tsx"
import styles from "./face.module.css"
import { bornRecently, type Reaction, reactions } from "./reactions.ts"

/** The colour of the light of a hue, for a swatch in the agent form. */
export const faceColour = (hue: number) => faceTones(hue).glow

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** One part of the features, painted for one layer. The colour comes from the layer. */
const Part = (props: { part: FacePart; layer: FaceLayer }) => {
  const paint = () =>
    Object.fromEntries(
      Object.entries(facePaint(props.part, { ...props.layer, colour: "currentColor" })).map(
        ([name, value]) => [kebab(name), value],
      ),
    )
  return <Dynamic component={props.part.tag} {...props.part.geometry} {...paint()} />
}

/**
 * One layer of the light of a face. The colour is `color` of the group, so a new hue is one
 * change for each layer, and the colour can change softly. The eyes are one group, so that a blink
 * can close them.
 */
const Layer = (props: { shape: number; layer: FaceLayer }) => {
  const eyes = () => faceParts(props.shape).filter((part) => part.eyes)
  const rest = () => faceParts(props.shape).filter((part) => !part.eyes)
  return (
    <g class={styles.layer} style={{ color: props.layer.colour }}>
      <Show when={eyes().length > 0}>
        <g class={styles.eyes} data-part="eyes">
          <For each={eyes()}>{(part) => <Part part={part} layer={props.layer} />}</For>
        </g>
      </Show>
      <For each={rest()}>{(part) => <Part part={part} layer={props.layer} />}</For>
    </g>
  )
}

const OUT = "cubic-bezier(0.23, 1, 0.32, 1)"
const IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)"

/** One blink: the lids close in 100 ms and open slower, 170 ms. */
const blink = (root: Element, delay = 0) => {
  // The glow and the core are two drawings of the same eyes, so both must close.
  for (const eyes of root.querySelectorAll("[data-part=eyes]")) {
    eyes.animate(
      [
        { transform: "scaleY(1)", easing: IN_OUT },
        { transform: "scaleY(0.1)", offset: 0.37, easing: OUT },
        { transform: "scaleY(1)" },
      ],
      { duration: 270, delay },
    )
  }
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
 * A round agent face: an uploaded picture, or a drawn character that glows in the dark in one of
 * ten hues, like the app mark.
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
  const tones = () => faceTones(props.face.hue)
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
          <circle class={styles.skin} cx="32" cy="32" r="32" style={{ fill: tones().tile }} />
          {/* A thin rim of light, so that the dark tile keeps its shape on a dark surface. */}
          <circle
            class={styles.rim}
            cx="32"
            cy="32"
            r="31.25"
            fill="none"
            stroke-width="1.5"
            style={{ stroke: tones().ring }}
          />
          {/* One entry for each shape: a new shape comes in anew, a new hue only changes the colours.
              (A `Show` on the shape would drop shape 0, because 0 is false.) */}
          <For each={[props.face.shape]}>
            {(shape) => (
              <g class={props.swap ? styles.swap : undefined}>
                <Index each={faceLayers(props.face.hue, props.size)}>
                  {(layer) => <Layer shape={shape} layer={layer()} />}
                </Index>
              </g>
            )}
          </For>
        </svg>
      }
    >
      {(image) => (
        <img
          ref={mark}
          class={styles.picture}
          src={image()}
          width={props.size}
          height={props.size}
          alt={props.label ?? ""}
          style={{ "outline-color": tones().ring }}
        />
      )}
    </Show>
  )
}
