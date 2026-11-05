import { type ChatThread, canAddThread, type MessageKey, type ThreadBusy } from "@robot/shared"
import { ChevronDown } from "lucide-solid"
import { createEffect, createSignal, Show } from "solid-js"
import styles from "../agents/agents.module.css"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { type MenuItem, PopupMenu } from "../ui/Menu.tsx"
import { Presence } from "../ui/Presence.tsx"
import { createThreads, openThread, openThreadOf } from "./threads.ts"

/** The reason why a thread cannot be archived or deleted now (spec 003). */
const busyKey = (busy: ThreadBusy) => `threads.busy.${busy}` as MessageKey

/**
 * The list of threads in the chat header (spec 003, "Threads"): the main thread, the other
 * threads, and the archived ones. The open thread has Rename, Archive or Restore, and Delete.
 */
export const ThreadList = (props: { agentId: string }) => {
  const { t } = useApp()
  const threads = createThreads(() => props.agentId)
  const current = () => openThreadOf(props.agentId)
  const thread = () => threads.list.threads.find((x) => x.id === current())
  const [position, setPosition] = createSignal<{ top: number; left: number }>()
  const [renaming, setRenaming] = createSignal<ChatThread>()
  const [deleting, setDeleting] = createSignal<ChatThread>()
  const [error, setError] = createSignal<ErrorText>()
  let trigger: HTMLButtonElement | undefined

  const titleOf = (x: ChatThread) => x.title ?? t("threads.new")
  const withUnread = (title: string, unread: number) =>
    unread > 0 ? t("threads.unread", { title, n: unread }) : title
  const atLimit = () => !canAddThread(threads.list.threads.length)

  // A thread that was deleted elsewhere closes: the main thread shows. Only a thread that the list
  // showed before counts, because a new thread opens before the list has loaded it.
  const seen = new Set<string>()
  createEffect(() => {
    for (const x of threads.list.threads) seen.add(x.id)
    const id = current()
    if (id && threads.loaded && !thread() && seen.has(id)) openThread(props.agentId, null)
  })

  const run = async (work: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await work()
    } catch (e) {
      setError(describeError(e))
    }
  }
  const create = () =>
    run(async () => {
      const made = await call("chat.thread.create", { agentId: props.agentId })
      openThread(props.agentId, made.id)
    })

  const items = (): MenuItem[] => {
    const open = (x: ChatThread) => ({
      label: withUnread(titleOf(x), x.unread),
      onSelect: () => openThread(props.agentId, x.id),
      checked: current() === x.id,
      testId: "thread-item",
    })
    const active = threads.list.threads.filter((x) => x.archivedAt === null)
    const archived = threads.list.threads.filter((x) => x.archivedAt !== null)
    const list: MenuItem[] = [
      {
        label: withUnread(t("threads.main"), threads.list.main.unread),
        onSelect: () => openThread(props.agentId, null),
        checked: current() === null,
        testId: "thread-main",
      },
      ...active.map(open),
      {
        label: t("threads.create"),
        onSelect: () => void create(),
        disabled: atLimit(),
        testId: "thread-create",
      },
    ]
    if (atLimit())
      list.push({
        label: t("threads.limit"),
        onSelect: () => {},
        heading: true,
        testId: "thread-limit",
      })
    if (archived.length > 0)
      list.push(
        { label: t("threads.archived"), onSelect: () => {}, heading: true },
        ...archived.map(open),
      )
    const x = thread()
    if (x) {
      const busy = x.busy
      list.push(
        { label: titleOf(x), onSelect: () => {}, heading: true },
        { label: t("threads.rename"), onSelect: () => setRenaming(x), testId: "thread-rename" },
        x.archivedAt === null
          ? {
              label: t("threads.archive"),
              onSelect: () =>
                void run(() =>
                  call("chat.thread.archive", {
                    agentId: props.agentId,
                    threadId: x.id,
                    archived: true,
                  }),
                ),
              disabled: busy !== null,
              testId: "thread-archive",
            }
          : {
              label: t("threads.restore"),
              onSelect: () =>
                void run(() =>
                  call("chat.thread.archive", {
                    agentId: props.agentId,
                    threadId: x.id,
                    archived: false,
                  }),
                ),
              testId: "thread-restore",
            },
        {
          label: t("threads.delete"),
          onSelect: () => setDeleting(x),
          disabled: busy !== null,
          danger: true,
          testId: "thread-delete",
        },
      )
      if (busy)
        list.push({
          label: t(busyKey(busy)),
          onSelect: () => {},
          heading: true,
          testId: "thread-busy",
        })
    }
    return list
  }

  const toggle = () => {
    if (position()) return setPosition(undefined)
    const box = trigger?.getBoundingClientRect()
    if (box) setPosition({ top: box.bottom + 4, left: box.left })
  }
  const label = () => {
    const x = thread()
    return x ? titleOf(x) : t("threads.main")
  }
  const unreadElsewhere = () =>
    (current() === null ? 0 : threads.list.main.unread) +
    threads.list.threads.reduce((n, x) => n + (x.id === current() ? 0 : x.unread), 0)

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={`${styles.headerModel} ${styles.threadButton}`}
        aria-haspopup="menu"
        aria-expanded={position() !== undefined}
        aria-label={t("threads.list", { title: label() })}
        title={label()}
        onClick={toggle}
        data-testid="thread-list"
        data-unread={unreadElsewhere() > 0 ? "true" : undefined}
      >
        <span class={styles.threadTitle} data-testid="thread-current">
          {label()}
        </span>
        <ChevronDown size={12} />
      </button>
      <Show when={position()}>
        {(at) => (
          <PopupMenu
            items={items()}
            top={at().top}
            left={at().left}
            label={t("threads.title")}
            testId="thread-menu"
            onClose={(refocus) => {
              setPosition(undefined)
              if (refocus) trigger?.focus()
            }}
          />
        )}
      </Show>
      <Show when={error()}>
        {(err) => (
          <span class={styles.threadError} role="alert" data-testid="thread-error">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
      <Presence when={renaming()}>
        {(x) => (
          <RenameDialog agentId={props.agentId} thread={x} onClose={() => setRenaming(undefined)} />
        )}
      </Presence>
      <Presence when={deleting()}>
        {(x) => (
          <DeleteDialog agentId={props.agentId} thread={x} onClose={() => setDeleting(undefined)} />
        )}
      </Presence>
    </>
  )
}

const RenameDialog = (props: { agentId: string; thread: ChatThread; onClose: () => void }) => {
  const { t } = useApp()
  const [title, setTitle] = createSignal(props.thread.title ?? "")
  const [error, setError] = createSignal<ErrorText>()
  const save = async (event: Event) => {
    event.preventDefault()
    try {
      await call("chat.thread.rename", {
        agentId: props.agentId,
        threadId: props.thread.id,
        title: title(),
      })
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <Dialog label={t("threads.rename")} onClose={props.onClose} testId="thread-rename-dialog">
      <form class={styles.form} onSubmit={save}>
        <h2 class={styles.title}>{t("threads.rename")}</h2>
        <input
          class={styles.input}
          value={title()}
          maxLength={60}
          onInput={(e) => setTitle(e.currentTarget.value)}
          aria-label={t("threads.rename.field")}
          data-testid="thread-rename-input"
          autofocus
        />
        <Show when={error()}>
          {(err) => <div class={styles.error}>{t(err().key, err().params)}</div>}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose}>{t("agents.cancel")}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!title().trim()}
            data-testid="thread-rename-save"
          >
            {t("threads.rename.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

const DeleteDialog = (props: { agentId: string; thread: ChatThread; onClose: () => void }) => {
  const { t } = useApp()
  const [error, setError] = createSignal<ErrorText>()
  const remove = async () => {
    try {
      await call("chat.thread.delete", { agentId: props.agentId, threadId: props.thread.id })
      openThread(props.agentId, null)
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    }
  }
  const title = () => props.thread.title ?? t("threads.new")
  return (
    <Dialog
      label={t("threads.delete.title", { title: title() })}
      onClose={props.onClose}
      testId="thread-delete-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("threads.delete.title", { title: title() })}</h2>
        <p>{t("threads.delete.body")}</p>
        <Show when={error()}>
          {(err) => <div class={styles.error}>{t(err().key, err().params)}</div>}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose}>{t("agents.cancel")}</Button>
          <Button
            variant="danger"
            onClick={() => void remove()}
            data-testid="thread-delete-confirm"
          >
            {t("threads.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
