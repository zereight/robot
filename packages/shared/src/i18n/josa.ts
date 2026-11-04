/**
 * Korean particles that pair by the last sound of the word before them: 을/를, 이/가, 은/는, 과/와
 * and 으로/로. A catalogue writes a pair as "을(를)" so that it reads right for any name. When the
 * text is filled, `resolveJosa` picks one of the two from the sound at the end of the word before
 * the particle, so "Ada을(를)" becomes "Ada를" and "민준을(를)" becomes "민준을".
 *
 * It decides only when the sound is certain: a Korean syllable, a digit, or a Latin name that ends
 * in a vowel letter or in l, m or n. For any other name (a Latin name that ends in "b" or "k"
 * might be read with or without a final consonant) the pair stays as it is written, which is
 * correct for any name.
 */

const PARTICLES = /(?:을\(를\)|이\(가\)|은\(는\)|과\(와\)|와\(과\)|\(으\)로)/gu

/** Closing marks that the particle may stand behind: the word before them gives the sound. */
const CLOSERS = new Set([")", "]", "}", '"', "'", "”", "’", "」", "』", ">"])

/** Digits read in Korean with a final consonant: 영, 삼 and 육. (일, 칠 and 팔 end in ㄹ.) */
const DIGIT_CLOSED = new Set(["0", "3", "6"])

/** Latin letters that are read as a vowel at the end of a word. */
const LATIN_OPEN = new Set(["a", "e", "i", "o", "u", "y"])
/** Latin letters that Korean reads with a final consonant: ㄹ, ㅁ and ㄴ. */
const LATIN_CLOSED = new Set(["l", "m", "n"])

/**
 * Whether the word that ends with `text` is read with a final consonant (a batchim): `"closed"`,
 * `"open"` or `"rieul"` (the final consonant ㄹ, which takes 로 and not 으로). `undefined` when the
 * sound is not certain.
 */
const ending = (text: string): "closed" | "open" | "rieul" | undefined => {
  const chars = [...text]
  let at = chars.length - 1
  while (at >= 0 && CLOSERS.has(chars[at] as string)) at--
  const last = chars[at]
  if (last === undefined) return undefined
  const code = last.codePointAt(0) as number
  if (code >= 0xac00 && code <= 0xd7a3) {
    const final = (code - 0xac00) % 28
    return final === 0 ? "open" : final === 8 ? "rieul" : "closed"
  }
  if (/[0-9]/.test(last)) {
    if (last === "1" || last === "7" || last === "8") return "rieul"
    return DIGIT_CLOSED.has(last) ? "closed" : "open"
  }
  const letter = last.toLowerCase()
  if (LATIN_OPEN.has(letter)) return "open"
  if (letter === "l") return "rieul"
  if (LATIN_CLOSED.has(letter)) return "closed"
  return undefined
}

/** Replaces each pair of particles after a word with the one that fits the end of the word. */
export const resolveJosa = (text: string): string =>
  text.replace(PARTICLES, (pair: string, offset: number) => {
    const sound = ending(text.slice(0, offset))
    if (sound === undefined) return pair
    const closed = sound !== "open"
    if (pair === "을(를)") return closed ? "을" : "를"
    if (pair === "이(가)") return closed ? "이" : "가"
    if (pair === "은(는)") return closed ? "은" : "는"
    if (pair === "과(와)" || pair === "와(과)") return closed ? "과" : "와"
    // (으)로: no final consonant, or ㄹ, takes 로.
    return sound === "closed" ? "으로" : "로"
  })
