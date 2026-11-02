import type { PlaceRef } from "@robot/shared"
import { createEffect, createSignal, onCleanup } from "solid-js"

/** A message that a notification asks to show. The open view scrolls to it, then clears it. */
export const [focusMessage, setFocusMessage] = createSignal<string>()

/**
 * Where the user was before a hit of message search opened another place (spec 001). The view of
 * the new place shows "Back" while this is set, and Back opens `from` again.
 */
export interface SearchOrigin {
  readonly serverId: string | undefined
  readonly from: PlaceRef
  readonly to: PlaceRef
}
export const [searchOrigin, setSearchOrigin] = createSignal<SearchOrigin>()

/** The origin of the hit that opened `place`, if the user came from a hit. */
export const originFor = (place: PlaceRef): SearchOrigin | undefined => {
  const origin = searchOrigin()
  return origin && origin.to.kind === place.kind && origin.to.id === place.id ? origin : undefined
}

/**
 * Shows the message that was asked for (by a notification, or by a hit of message search). The
 * list of a place that just opened may still load, so `jump` is tried again for about 3 seconds
 * until it finds the row. `jump` returns true when it scrolled to the message.
 */
export const useFocusMessage = (
  place: PlaceRef,
  jump: (messageId: string, fromSearch: boolean) => boolean,
) => {
  createEffect(() => {
    const id = focusMessage()
    if (!id) return
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = () => {
      if (jump(id, originFor(place) !== undefined) || ++tries >= 30) {
        setFocusMessage(undefined)
        return
      }
      timer = setTimeout(attempt, 100)
    }
    timer = setTimeout(attempt, 120)
    onCleanup(() => clearTimeout(timer))
  })
}
