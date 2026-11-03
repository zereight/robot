import styles from "./workmark.module.css"

/** The two smiling eyes of the app mark (the same shapes as `AppMark`). */
const Eyes = (props: { class?: string | undefined }) => (
  <svg class={props.class} viewBox="194.6 414 635 165" aria-hidden="true">
    <path d="M204.6 569 A145 145 0 0 1 494.6 569 A43.5 43.5 0 0 1 407.6 569 A58 58 0 0 0 291.6 569 A43.5 43.5 0 0 1 204.6 569 Z" />
    <path d="M529.4 569 A145 145 0 0 1 819.4 569 A43.5 43.5 0 0 1 732.4 569 A58 58 0 0 0 616.4 569 A43.5 43.5 0 0 1 529.4 569 Z" />
  </svg>
)

/**
 * The app mark as a small badge: two smiling eyes that glow on a dark tile. It stands for an
 * agent that works or speaks. The tile is dark in both themes, so the eyes can be light. The eyes
 * open when the badge comes in, and the glow breathes while the badge shows. With reduce motion
 * on, the eyes are open and the glow is still.
 */
export const WorkMark = () => (
  <span class={styles.tile} data-testid="work-mark" aria-hidden="true">
    <span class={styles.eyes}>
      <Eyes class={styles.glow} />
      <Eyes class={styles.crisp} />
    </span>
  </span>
)
