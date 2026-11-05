import { createSignal } from "solid-js"

// The search text that the org chart opens with (spec 029, "Ways in"). A hit in the search of the
// place list opens the page and puts the name of the organization in the search field, so the user
// lands on the organization and not only on the page. It is read once and then cleared.

export const [orgFilter, setOrgFilter] = createSignal<string | undefined>()

/** Takes the text once: the page clears it, so a later open of the page starts with no search. */
export const takeOrgFilter = () => {
  const text = orgFilter()
  if (text !== undefined) setOrgFilter(undefined)
  return text
}
