import {
  AGENT_ROLE_MAX,
  choiceText,
  isPickable,
  type RoleChoice,
  roleChoices,
  roleKey,
  roleList,
  startMark,
  stepMark,
} from "@robot/shared"
import { Check, ChevronDown, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { IconButton } from "../ui/controls.tsx"
import styles from "./role.module.css"

/**
 * The role line as a chip (spec 002, "Role label"). A long role is cut with "…", and the whole
 * text shows in a note when the pointer rests on the chip. With `onOpen` the chip is a button that
 * opens the list; without it the chip is text only, as on a linked computer that does not let this
 * device change agents.
 */
export const RoleChip = (props: { role: string; testId?: string }) => {
  return (
    <span
      class={styles.chip}
      title={props.role}
      data-testid={props.testId ?? "agent-role-chip"}
      data-user-data
    >
      <span class={`${styles.chipText} ${styles.chipPlain}`}>{props.role}</span>
    </span>
  )
}

/**
 * The field "Role" of the form of an agent: the chip with "Remove" when the agent has a role line,
 * and a muted "Choose a role" button when it has none. Both open a list of the roles that agents
 * of this server have, with a text box to filter it or to add a new role. The field changes the
 * form only. The agent changes when the user saves the form.
 */
export const RoleField = (props: {
  /** The role line in the form now. */
  value: string
  onChange: (role: string) => void
  /** Gets the button that opens the list, so the form can move the focus to it. */
  triggerRef?: (element: HTMLButtonElement) => void
  invalid?: boolean
  describedBy?: string | undefined
}) => {
  const app = useApp()
  const { t } = app
  const agents = useAgents()
  const listId = createUniqueId()
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal("")
  const [mark, setMark] = createSignal(-1)
  let root: HTMLDivElement | undefined
  let trigger: HTMLButtonElement | undefined
  let filter: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined

  // The roles of the agents that are not archived, one for each spelling in any case (spec 013).
  const roles = createMemo(() => roleList(agents.agents(), app.locale()))
  const choices = createMemo(() => roleChoices(roles(), text()))
  const tooLong = () => choices().some((c) => c.kind === "add" && c.off)
  const optionId = (index: number) => `${listId}-${index}`

  // The mark starts on the first choice, or on the listed role that is the same as the text.
  createEffect(on([choices, text], ([list, typed]) => setMark(startMark(list, typed))))
  // The marked choice stays in view in a long list.
  createEffect(() => {
    const at = mark()
    if (open() && at >= 0) list?.children[at]?.scrollIntoView?.({ block: "nearest" })
  })

  const setTrigger = (element: HTMLButtonElement) => {
    trigger = element
    props.triggerRef?.(element)
  }
  const openList = () => {
    setText("")
    setOpen(true)
    // The text box gets the focus when the list opens.
    queueMicrotask(() => filter?.focus())
  }
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) queueMicrotask(() => trigger?.focus())
  }
  const pick = (choice: RoleChoice | undefined) => {
    if (!choice || !isPickable(choice)) return
    props.onChange(choiceText(choice))
    close(true)
  }
  const remove = () => {
    props.onChange("")
    close(false)
    // The chip is gone, and the button "Choose a role" takes its place.
    queueMicrotask(() => trigger?.focus())
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Escape closes the list and changes nothing. The box around the form stays open.
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      setMark(stepMark(choices(), mark(), event.key === "ArrowDown" ? 1 : -1))
    } else if (event.key === "Enter" && !event.isComposing) {
      // Enter must not send the form.
      event.preventDefault()
      pick(choices()[mark()])
    } else if (event.key === "Tab") {
      close(false)
    }
  }
  // A click or a key outside the field closes the list. The focus moves where the user put it.
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null
    if (open() && !root?.contains(next)) setOpen(false)
  }

  const isCurrent = (name: string) => props.value !== "" && roleKey(name) === roleKey(props.value)

  return (
    <div ref={root} class={styles.field} onFocusOut={onFocusOut} data-testid="agent-role">
      <Show
        when={props.value !== ""}
        fallback={
          <button
            ref={setTrigger}
            type="button"
            class={styles.choose}
            aria-haspopup="listbox"
            aria-expanded={open()}
            aria-invalid={props.invalid ? true : undefined}
            aria-describedby={props.describedBy}
            onClick={() => (open() ? close(false) : openList())}
            data-testid="agent-role-open"
          >
            <span>{t("agents.role.choose")}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        }
      >
        <span class={styles.chip} data-invalid={props.invalid ? "true" : undefined}>
          <button
            ref={setTrigger}
            type="button"
            class={styles.chipButton}
            title={props.value}
            aria-haspopup="listbox"
            aria-expanded={open()}
            aria-invalid={props.invalid ? true : undefined}
            aria-describedby={props.describedBy}
            aria-label={t("agents.role.chip", { role: props.value })}
            onClick={() => (open() ? close(false) : openList())}
            data-testid="agent-role-chip"
          >
            <span class={styles.chipText} data-user-data>
              {props.value}
            </span>
          </button>
          <IconButton
            class={styles.chipRemove}
            label={t("agents.role.remove")}
            onClick={remove}
            data-testid="agent-role-remove"
          >
            <X size={12} aria-hidden="true" />
          </IconButton>
        </span>
      </Show>

      <Show when={open()}>
        {/* The list is part of the form, so it never hides under the box. It keeps Escape. */}
        <div class={styles.panel} data-owns-escape data-testid="agent-role-list">
          <input
            ref={filter}
            class={styles.filter}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={mark() >= 0 ? optionId(mark()) : undefined}
            aria-autocomplete="list"
            aria-label={t("agents.role.filter")}
            placeholder={t("agents.role.filter")}
            autocomplete="off"
            spellcheck={false}
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
            onKeyDown={onKey}
            data-testid="agent-role-filter"
          />
          <div
            ref={list}
            id={listId}
            class={styles.options}
            role="listbox"
            aria-label={t("agents.role.list")}
          >
            <For each={choices()}>
              {(choice, index) => (
                // The text box keeps the focus, so a press does not end the typing.
                <button
                  type="button"
                  tabIndex={-1}
                  id={optionId(index())}
                  class={styles.option}
                  role="option"
                  aria-selected={mark() === index()}
                  aria-disabled={isPickable(choice) ? undefined : true}
                  aria-current={
                    choice.kind === "role" && isCurrent(choice.name) ? "true" : undefined
                  }
                  aria-label={
                    choice.kind === "role"
                      ? t("agents.role.option", { role: choice.name, count: choice.count })
                      : undefined
                  }
                  data-kind={choice.kind}
                  data-off={isPickable(choice) ? undefined : "true"}
                  data-testid={choice.kind === "add" ? "agent-role-add" : "agent-role-option"}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => isPickable(choice) && setMark(index())}
                  onClick={() => pick(choice)}
                >
                  <Show
                    when={choice.kind === "role" ? choice : undefined}
                    fallback={
                      <span class={styles.optionText} data-user-data>
                        {t("agents.role.add", { role: choice.name })}
                      </span>
                    }
                  >
                    {(role) => (
                      <>
                        <span class={styles.optionCheck} aria-hidden="true">
                          <Show when={isCurrent(role().name)}>
                            <Check size={14} />
                          </Show>
                        </span>
                        <span class={styles.optionText} data-user-data>
                          {role().name}
                        </span>
                        <span class={styles.optionCount} data-testid="agent-role-count">
                          {role().count}
                        </span>
                      </>
                    )}
                  </Show>
                </button>
              )}
            </For>
          </div>
          <Show when={choices().length === 0}>
            <p class={styles.note} data-testid="agent-role-none">
              {t("agents.role.none")}
            </p>
          </Show>
          <Show when={tooLong()}>
            <p class={styles.note} data-testid="agent-role-toolong">
              {t("agents.error.role_long", { max: AGENT_ROLE_MAX })}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}
