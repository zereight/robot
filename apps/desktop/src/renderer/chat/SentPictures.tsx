import { type ChatMessage, type FilePart, messageFiles, pictureType } from "@robot/shared"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./chat.module.css"
import { loadFullPicture, loadSentPicture, type SentPictureAsk } from "./sentPictures.ts"

/**
 * The enlarged view of one sent picture. The small picture shows at once, and the full-size
 * picture takes its place when it arrives. Escape, a press outside, or Close leaves the view.
 */
const PictureViewer = (props: {
  message: ChatMessage
  file: FilePart
  thumb: string
  onClose: () => void
}) => {
  const { t } = useApp()
  const [full, setFull] = createSignal<string>()
  let alive = true
  onMount(() => {
    const ask: SentPictureAsk = {
      agentId: props.message.agentId,
      path: props.file.path,
      size: props.file.size,
      messageId: props.message.id,
    }
    void loadFullPicture(ask).then((url) => {
      if (!url) return
      // The view closed while the bytes came: let the address go at once.
      if (alive) setFull(url)
      else URL.revokeObjectURL(url)
    })
  })
  onCleanup(() => {
    alive = false
    const url = full()
    if (url) URL.revokeObjectURL(url)
  })
  return (
    <Dialog
      label={t("picture.enlarge", { name: props.file.name })}
      onClose={props.onClose}
      testId="picture-viewer"
      wide
    >
      <img
        class={styles.viewerImage}
        src={full() ?? props.thumb}
        alt={props.file.name}
        data-testid="picture-viewer-image"
      />
      <div class={styles.viewerActions}>
        <Button variant="primary" onClick={props.onClose} data-testid="picture-viewer-close">
          {t("picture.close")}
        </Button>
      </div>
    </Dialog>
  )
}

/**
 * One small picture of an image that a message holds. A box of the full size waits first, so the
 * row does not grow when the picture comes and the chat that follows the end stays at the end. The
 * picture loads when the box is near the screen, so a long chat does not load every picture at once.
 * A press opens the enlarged view.
 */
const SentPicture = (props: {
  message: ChatMessage
  file: FilePart
  onOpen: (thumb: string) => void
}) => {
  const { t } = useApp()
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
            <button
              type="button"
              class={styles.sentPictureButton}
              onClick={() => props.onOpen(url())}
              aria-label={t("picture.enlarge", { name: props.file.name })}
              title={t("picture.enlarge", { name: props.file.name })}
              data-testid="message-picture-open"
            >
              <img
                class={styles.sentPictureImage}
                src={url()}
                alt={props.file.name}
                data-testid="message-picture"
              />
            </button>
          )}
        </Show>
      </div>
    </Show>
  )
}

/**
 * The small pictures above a message that holds image files (spec 003, flow 4). The file chips stay
 * below the text, and they are the way to open or save the file. A press on a picture shows it
 * enlarged.
 */
export const SentPictures = (props: { message: ChatMessage }) => {
  const pictures = createMemo(() => messageFiles(props.message).filter((f) => pictureType(f.name)))
  const [open, setOpen] = createSignal<{ file: FilePart; thumb: string }>()
  return (
    <Show when={pictures().length > 0}>
      <div class={styles.sentPictures} data-testid="message-pictures">
        <For each={pictures()}>
          {(file) => (
            <SentPicture
              message={props.message}
              file={file}
              onOpen={(thumb) => setOpen({ file, thumb })}
            />
          )}
        </For>
      </div>
      <Show when={open()}>
        {(view) => (
          <PictureViewer
            message={props.message}
            file={view().file}
            thumb={view().thumb}
            onClose={() => setOpen(undefined)}
          />
        )}
      </Show>
    </Show>
  )
}
