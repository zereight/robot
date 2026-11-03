import type { LucideProps } from "lucide-solid"
import type { Component } from "solid-js"
import styles from "./avatarmark.module.css"

/**
 * A round mark in the family of the app mark: a very dark disc, a thin rim of light, and a glyph
 * of light on it. The user has one, and a channel has one in place of a face. Like a face, it
 * glows without a blur filter: the glow is wider, fainter copies of the glyph and a second ring.
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
      <span class={styles.glow}>
        <props.icon size={glyph()} strokeWidth={5} />
      </span>
      <span class={styles.core}>
        <props.icon size={glyph()} strokeWidth={2} />
      </span>
    </span>
  )
}
