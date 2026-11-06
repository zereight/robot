import { cutChars } from "./chars.ts"

// Pictures from the web (spec 003, "Pictures from the web"). A picture in a Markdown text can
// carry data in its address. So a picture from the web loads only when the user asks. The computer
// and the phone use the same decision, and each draws its own box.

/** The alt text in the box is cut at this many characters. */
export const PICTURE_ALT_MAX = 80
/** The address in the box is cut at this many characters. */
export const PICTURE_ADDRESS_MAX = 100

/** What to draw for one picture of a Markdown text. */
export type Picture =
  /** A `data:image` address. The data is in the text, so it needs no network: show it at once. */
  | { readonly kind: "inline"; readonly src: string; readonly alt: string }
  /** An `https` address: a box with a button. The picture loads when the user presses it. */
  | { readonly kind: "ask"; readonly src: string; readonly alt: string; readonly box: PictureBox }
  /** Any other address (`http` and the rest): a box with no button. The picture never loads. */
  | { readonly kind: "blocked"; readonly box: PictureBox }

/** The words of a box. */
export interface PictureBox {
  /** The alt text, cut. The empty text means the box shows the word "Image". */
  readonly alt: string
  readonly altCut: boolean
  /** The address, cut. */
  readonly address: string
  readonly addressCut: boolean
}

const box = (alt: string, address: string): PictureBox => {
  const shortAlt = cutChars(alt, PICTURE_ALT_MAX)
  const shortAddress = cutChars(address, PICTURE_ADDRESS_MAX)
  return {
    alt: shortAlt,
    altCut: shortAlt !== alt,
    address: shortAddress,
    addressCut: shortAddress !== address,
  }
}

/** Decides how to show a picture with this address and alt text. */
export const decidePicture = (href: string, alt: string): Picture => {
  const address = href.trim()
  const text = alt.replace(/\s+/g, " ").trim()
  if (/^data:image\//i.test(address)) return { kind: "inline", src: address, alt: text }
  if (/^https:\/\//i.test(address))
    return { kind: "ask", src: address, alt: text, box: box(text, address) }
  return { kind: "blocked", box: box(text, address) }
}

/** The key of a picture in a message or an article. The same address twice in one text is one. */
export const pictureKey = (scope: string, address: string) => `${scope}\n${address.trim()}`

/** The pictures that the user loaded since the app started. It is not saved. */
export interface LoadedPictures {
  /** True when the user loaded this address in this message. */
  readonly has: (scope: string, address: string) => boolean
  readonly load: (scope: string, address: string) => void
  /** Calls `listener` after each load. Gives back the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void
}

export const createLoadedPictures = (): LoadedPictures => {
  const loaded = new Set<string>()
  const listeners = new Set<() => void>()
  return {
    has: (scope, address) => loaded.has(pictureKey(scope, address)),
    load: (scope, address) => {
      const key = pictureKey(scope, address)
      if (loaded.has(key)) return
      loaded.add(key)
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
