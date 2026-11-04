import { cleanNames, namesOfText, teamsNameKey } from "@robot/shared"
import { Plus, X } from "lucide-solid"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import teamStyles from "./teams.module.css"

/**
 * A list of sender names (spec 028): each name is a chip, and one box adds the next. Enter, a paste
 * with many lines, or leaving the box adds the typed text. A comma does not split a name, as Teams
 * may show "Kim, Tao". The optional finder reads the senders that the open chat shows and offers
 * the new ones. It adds none by itself: a name on the list lets that sender give work to the agent.
 */
export const NameList = (props: {
  /** The id of the box, so that the label of the field points at it. */
  id: string
  names: readonly string[]
  /** Saves the new list. Gives true when it was saved. */
  onChange: (names: string[]) => Promise<boolean>
  /** Reads the sender names of the open chat. Rejects with the reason that the user sees. */
  find?: () => Promise<readonly string[]>
}) => {
  const { t } = useApp()
  let box: HTMLInputElement | undefined
  const [draft, setDraft] = createSignal("")

  // The list that was asked for and not yet shown back by the app. It lets a second name join the
  // first one while the first is still being saved, and it keeps a chip from jumping away.
  const [asked, setAsked] = createSignal<string[]>()
  let saving = 0
  const names = () => asked() ?? props.names
  // A list that comes from the app is the truth, unless a save is still on its way.
  createEffect(
    on(
      () => props.names,
      () => {
        if (saving === 0) setAsked(undefined)
      },
      { defer: true },
    ),
  )
  const save = async (next: string[]) => {
    setAsked(next)
    saving++
    let saved = false
    try {
      saved = await props.onChange(next)
    } finally {
      saving--
      // A refused list goes back to the list of the app.
      if (!saved && saving === 0) setAsked(undefined)
    }
  }

  const add = (typed: readonly string[]) => {
    const next = cleanNames([...names(), ...typed])
    if (next.length !== names().length) void save(next)
  }
  const remove = (name: string) => {
    const key = teamsNameKey(name)
    void save(names().filter((n) => teamsNameKey(n) !== key))
  }
  const takeDraft = () => {
    const text = draft()
    setDraft("")
    if (text.trim() !== "") add(namesOfText(text))
  }

  // The finder.
  const [found, setFound] = createSignal<readonly string[]>()
  const [finding, setFinding] = createSignal(false)
  const [findError, setFindError] = createSignal<ErrorText>()
  const candidates = () => {
    const have = new Set(names().map(teamsNameKey))
    return (found() ?? []).filter((name) => !have.has(teamsNameKey(name)))
  }
  const find = async () => {
    if (!props.find || finding()) return
    setFinding(true)
    setFindError(undefined)
    try {
      setFound(await props.find())
    } catch (e) {
      setFound(undefined)
      setFindError(describeError(e))
    } finally {
      setFinding(false)
    }
  }

  return (
    <>
      {/* The box is a click target for the field in it. The field has the keys. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the input inside takes the keys */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click moves focus to the input */}
      <div
        class={teamStyles.names}
        onClick={(e) => e.target === e.currentTarget && box?.focus()}
        data-testid={`${props.id}-names`}
      >
        <For each={names()}>
          {(name) => (
            <span class={teamStyles.nameChip} data-testid={`${props.id}-chip`}>
              <span class={teamStyles.nameChipText} data-user-data>
                {name}
              </span>
              <button
                type="button"
                class={teamStyles.nameChipRemove}
                aria-label={t("teams.names.remove", { name })}
                title={t("teams.names.remove", { name })}
                onClick={() => remove(name)}
                data-testid={`${props.id}-remove`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          )}
        </For>
        <input
          ref={box}
          id={props.id}
          class={teamStyles.namesInput}
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={draft()}
          placeholder={names().length === 0 ? t("teams.names.placeholder") : undefined}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            // A key that picks a letter in an input method (Korean, for example) is not a command.
            if (e.isComposing || e.keyCode === 229) return
            if (e.key === "Enter") {
              e.preventDefault()
              takeDraft()
            } else if (e.key === "Backspace" && draft() === "" && names().length > 0) {
              remove(names()[names().length - 1] as string)
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData?.getData("text") ?? ""
            // A box of one line would join the lines of a pasted list into one name.
            if (!/\r?\n/.test(text)) return
            e.preventDefault()
            add(namesOfText(`${draft()}${text}`))
            setDraft("")
          }}
          onBlur={takeDraft}
          data-testid={props.id}
          data-user-data
        />
      </div>

      <Show when={props.find}>
        <div class={teamStyles.fieldRow}>
          <Button onClick={() => void find()} disabled={finding()} data-testid={`${props.id}-find`}>
            {finding() ? t("teams.names.finding") : t("teams.names.find")}
          </Button>
        </div>
        <Show when={findError()}>
          {(err) => (
            <div class={teamStyles.problem} role="alert" data-testid={`${props.id}-find-error`}>
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <Show when={found() !== undefined}>
          <Show
            when={candidates().length > 0}
            fallback={
              <div class={teamStyles.note} role="status" data-testid={`${props.id}-found-none`}>
                {t("teams.names.none")}
              </div>
            }
          >
            <div class={teamStyles.note}>{t("teams.names.found")}</div>
            <div class={teamStyles.found} data-testid={`${props.id}-found`}>
              <For each={candidates()}>
                {(name) => (
                  <button
                    type="button"
                    class={teamStyles.suggestion}
                    aria-label={t("teams.names.add", { name })}
                    onClick={() => add([name])}
                    data-testid={`${props.id}-suggestion`}
                  >
                    <Plus size={12} aria-hidden="true" />
                    <span data-user-data>{name}</span>
                  </button>
                )}
              </For>
              <Show when={candidates().length > 1}>
                <Button onClick={() => add(candidates())} data-testid={`${props.id}-add-all`}>
                  {t("teams.names.addAll")}
                </Button>
              </Show>
            </div>
          </Show>
        </Show>
      </Show>
    </>
  )
}
