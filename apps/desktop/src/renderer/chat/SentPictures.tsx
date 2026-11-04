import { type ChatMessage, type FilePart, messageFiles, pictureType } from "@robot/shared"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import styles from "./chat.module.css"
import { loadSentPicture } from "./sentPictures.ts"

/**
 * One small picture of an image that a message holds. A box of the full size waits first, so the
 * row does not grow when the picture comes and the chat that follows the end stays at the end. The
 * picture loads when the box is near the screen, so a long chat does not load every picture at once.
 */
const SentPicture = (props: { message: ChatMessage; file: FilePart }) => {
  const [src, setSrc] = createSignal<string>()
  const [none, setNone] = createSignal(false)
  let box: HTMLDivElement | undefined
  onMount(() => {
    if (!box) return
    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        watch.disconnect()
        void loadSentPicture({
          agentId: props.message.agentId,
          path: props.file.path,
          size: props.file.size,
          messageId: props.message.id,
        }).then((url) => (url ? setSrc(url) : setNone(true)))
      },
      { rootMargin: "300px" },
    )
    watch.observe(box)
    onCleanup(() => watch.disconnect())
  })
  return (
    <Show when={!none()}>
      <div ref={box} class={styles.sentPicture} data-state={src() ? "loaded" : "loading"}>
        <Show when={src()}>
          {(url) => (
            <img
              class={styles.sentPictureImage}
              src={url()}
              alt={props.file.name}
              data-testid="message-picture"
            />
          )}
        </Show>
      </div>
    </Show>
  )
}

/**
 * The small pictures above a message that holds image files (spec 003, flow 4). The file chips stay
 * below the text, and they are the way to open or save the file.
 */
export const SentPictures = (props: { message: ChatMessage }) => {
  const pictures = createMemo(() => messageFiles(props.message).filter((f) => pictureType(f.name)))
  return (
    <Show when={pictures().length > 0}>
      <div class={styles.sentPictures} data-testid="message-pictures">
        <For each={pictures()}>{(file) => <SentPicture message={props.message} file={file} />}</For>
      </div>
    </Show>
  )
}
