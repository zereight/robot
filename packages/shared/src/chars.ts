/** The first `max` characters of a text. A character is a code point. */
export const cutChars = (text: string, max: number) => {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join("") : text
}

/** The last `max` characters of a text. */
export const endChars = (text: string, max: number) => {
  const chars = [...text]
  return chars.length > max ? chars.slice(chars.length - max).join("") : text
}

/** The number of characters of a text. A character is a code point. */
export const charLength = (text: string) => [...text].length

/** The key that makes names unique on a server: trimmed, NFC, ignoring case. */
export const nameKey = (name: string) => name.trim().normalize("NFC").toLocaleLowerCase()
