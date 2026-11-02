import { builtInSection, type PlaceKind } from "@robot/shared"
import { For } from "solid-js"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"

/**
 * The "Section" choice of a form: the user sections of one kind, and "No section".
 * A section that is gone shows as "No section".
 */
export const SectionSelect = (props: {
  kind: PlaceKind
  value: string | null
  onChange: (sectionId: string | null) => void
  class?: string | undefined
  testId: string
}) => {
  const { t } = useApp()
  const ui = useUi()
  const sections = () =>
    ui.sections().find((s) => s.id === builtInSection(props.kind))?.sections ?? []
  const known = () => sections().some((s) => s.id === props.value)
  return (
    <select
      class={props.class}
      aria-label={t("sections.field")}
      onChange={(e) => props.onChange(e.currentTarget.value || null)}
      data-testid={props.testId}
    >
      <option value="" selected={!known()}>
        {t("sections.none")}
      </option>
      <For each={sections()}>
        {(section) => (
          <option value={section.id} selected={props.value === section.id}>
            {section.name}
          </option>
        )}
      </For>
    </select>
  )
}
