/**
 * The arrow keys of a strip of tabs: Left and Right move to the tab before and after, Home and End
 * to the first and the last. The tab that gets the focus is selected, and only the selected tab is
 * in the tab order (the pattern of a tab list). The strip is the parent of the focused tab.
 */
export const tabKeyDown = <T extends string>(
  event: KeyboardEvent & { currentTarget: HTMLElement },
  names: readonly T[],
  current: T,
  select: (name: T) => void,
) => {
  const at = names.indexOf(current)
  let next = at
  if (event.key === "ArrowRight") next = (at + 1) % names.length
  else if (event.key === "ArrowLeft") next = (at - 1 + names.length) % names.length
  else if (event.key === "Home") next = 0
  else if (event.key === "End") next = names.length - 1
  else return
  event.preventDefault()
  const name = names[next]
  if (name === undefined) return
  select(name)
  const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')
  tabs?.[next]?.focus()
}
