import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./agents.module.css"

/** The memory items of one agent: search, add, edit and delete. */
export const MemoryPanel = (props: { agentId: string }) => {
  const { t } = useApp()
  const [query, setQuery] = createSignal("")
  const [draft, setDraft] = createSignal("")
  const [editing, setEditing] = createSignal<{ id: string; text: string }>()
  const [items, { refetch }] = createResource(
    () => ({ agentId: props.agentId, query: query() }),
    (input) => call("memory.list", input),
  )
  onCleanup(window.robot.on("memory.changed", () => void refetch()))

  const add = async () => {
    const text = draft().trim()
    if (!text) return
    setDraft("")
    await call("memory.add", { agentId: props.agentId, text })
  }

  return (
    <div class={styles.field} data-testid="memory-panel">
      <span class={styles.label}>{t("agents.memory.title")}</span>
      <span class={styles.hint}>{t("agents.memory.hint")}</span>
      <input
        class={styles.input}
        value={query()}
        placeholder={t("agents.memory.search")}
        aria-label={t("agents.memory.search")}
        onInput={(e) => setQuery(e.currentTarget.value)}
        data-testid="memory-search"
      />
      <div class={styles.memoryRow}>
        <input
          class={styles.input}
          value={draft()}
          placeholder={t("agents.memory.placeholder")}
          aria-label={t("agents.memory.placeholder")}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void add()
            }
          }}
          data-testid="memory-input"
        />
        <Button onClick={add} data-testid="memory-add">
          {t("agents.memory.add")}
        </Button>
      </div>
      <Show when={(items() ?? []).length === 0}>
        <span class={styles.hint}>{t("agents.memory.empty")}</span>
      </Show>
      <For each={items() ?? []}>
        {(item) => (
          <div class={styles.memoryRow} data-testid="memory-item">
            <Show
              when={editing()?.id === item.id ? editing() : undefined}
              fallback={
                <>
                  <span class={styles.memoryText}>{item.text}</span>
                  <span class={styles.hint}>{t(`agents.memory.source.${item.source}`)}</span>
                  <Button
                    onClick={() => setEditing({ id: item.id, text: item.text })}
                    data-testid="memory-edit"
                  >
                    {t("agents.memory.edit")}
                  </Button>
                  <Button
                    onClick={() => call("memory.delete", { id: item.id })}
                    data-testid="memory-delete"
                  >
                    {t("agents.memory.delete")}
                  </Button>
                </>
              }
            >
              {(edit) => (
                <>
                  <input
                    class={styles.input}
                    value={edit().text}
                    aria-label={t("agents.memory.placeholder")}
                    onInput={(e) => setEditing({ id: item.id, text: e.currentTarget.value })}
                    data-testid="memory-edit-input"
                  />
                  <Button
                    variant="primary"
                    onClick={async () => {
                      await call("memory.update", { id: item.id, text: edit().text })
                      setEditing(undefined)
                    }}
                    data-testid="memory-save"
                  >
                    {t("agents.memory.save")}
                  </Button>
                </>
              )}
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
