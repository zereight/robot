/** Scrolls to a card that a checklist item asked for, marks it for a moment, and focuses it. */
export const showRevealed = (card: HTMLElement, focusTestId: string) => {
  card.scrollIntoView({
    block: "center",
    behavior: document.documentElement.dataset.reduceMotion === "true" ? "auto" : "smooth",
  })
  card.dataset.revealed = "true"
  card.querySelector<HTMLElement>(`[data-testid="${focusTestId}"]`)?.focus()
  setTimeout(() => {
    delete card.dataset.revealed
  }, 2000)
}
