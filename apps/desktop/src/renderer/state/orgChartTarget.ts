import { createSignal } from "solid-js"

/**
 * A request to show one organization on the org chart (spec 029). The team chip of a lead (spec
 * 003) sets it and opens the page. The page focuses the node of that organization and clears it.
 */
export const [orgChartTarget, setOrgChartTarget] = createSignal<string>()
