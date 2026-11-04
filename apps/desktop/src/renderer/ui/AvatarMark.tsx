import type { LucideProps } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { resolvedTheme } from "../theme/current.ts"
import styles from "./avatarmark.module.css"

/**
 * A round mark in the family of the faces. In the dark theme it is a very dark disc with a thin
 * rim of light and a glyph of light, as the app mark is. In the light theme it is a light disc with
 * a dark glyph and no glow. The user has one, and a channel has one in place of a face. In the dark
 * theme it glows without a blur filter: the glow is a wider, fainter copy of the glyph and a
 * second ring.
 */
export const AvatarMark = (props: {
  icon: Component<LucideProps>
  /** The width of the disc, in px. */
  size: number
  testId?: string
}) => {
  const glyph = () => Math.round(props.size * 0.5)
  return (
    <span
      class={styles.disc}
      style={{ width: `${props.size}px`, height: `${props.size}px` }}
      data-testid={props.testId}
      aria-hidden="true"
    >
      <Show when={resolvedTheme() === "dark"}>
        <span class={styles.glow}>
          <props.icon size={glyph()} strokeWidth={5} />
        </span>
      </Show>
      <span class={styles.core}>
        <props.icon size={glyph()} strokeWidth={2} />
      </span>
    </span>
  )
}
