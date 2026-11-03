import { createLoadedPictures } from "@robot/shared/pictures"
import { createSignal } from "solid-js"

// The pictures from the web that the user loaded (spec 003, "Pictures from the web"). The choice
// holds while the app runs, for one address in one message or article. It is not saved, so a new
// start of the app shows every box again.

const loaded = createLoadedPictures()
const [loads, setLoads] = createSignal(0)
loaded.subscribe(() => setLoads((n) => n + 1))

/** True when the user loaded this address in this message or article. Reactive. */
export const isPictureLoaded = (scope: string, address: string) => {
  loads()
  return loaded.has(scope, address)
}

export const loadPicture = (scope: string, address: string) => loaded.load(scope, address)
