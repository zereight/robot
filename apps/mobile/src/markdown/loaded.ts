import { createLoadedPictures } from "@robot/shared/pictures"
import { useSyncExternalStore } from "react"

// The pictures from the web that the user loaded (spec 003, "Pictures from the web"). The choice
// holds while the app runs, for one address in one message. It is not saved, so after the phone
// app starts again every box shows again.

const loaded = createLoadedPictures()

/** True when the user loaded this address in this message. The view draws again when it changes. */
export const usePictureLoaded = (scope: string, address: string) =>
  useSyncExternalStore(loaded.subscribe, () => loaded.has(scope, address))

export const loadPicture = (scope: string, address: string) => loaded.load(scope, address)
