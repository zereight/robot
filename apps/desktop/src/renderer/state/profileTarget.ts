import { createSignal } from "solid-js"

/**
 * A request to open the profile of an agent (spec 002). A page that is not the chat of the agent,
 * the org chart for one (spec 029), opens the chat and sets the id. The header of that chat opens
 * the profile and clears the request.
 */
export const [profileTarget, setProfileTarget] = createSignal<string>()
