import { Hash } from "lucide-solid"
import { Show } from "solid-js"
import { AvatarMark } from "./AvatarMark.tsx"
import styles from "./channelmark.module.css"

/**
 * The mark of a channel (spec 004, "Picture"; 002, "Avatars"): its picture when it has one, round
 * and with the thin rim of an avatar, or the mark with the `#`. The picture does not change with
 * the theme. The name stands next to the mark, so the mark has no text of its own.
 */
export const ChannelMark = (props: {
  picture: string | null | undefined
  /** The width of the mark, in px. */
  size: number
  testId?: string
}) => (
  <Show
    when={props.picture}
    fallback={
      <AvatarMark
        icon={Hash}
        size={props.size}
        {...(props.testId ? { testId: props.testId } : {})}
      />
    }
  >
    {(src) => (
      <img
        class={styles.picture}
        src={src()}
        width={props.size}
        height={props.size}
        alt=""
        aria-hidden="true"
        draggable={false}
        data-testid={props.testId}
        data-channel-picture="true"
      />
    )}
  </Show>
)
