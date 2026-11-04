// Links of a Markdown text (spec 003). An agent can write a link with no scheme, such as
// `[docs](www.example.com/guide)`. Such a link shows blue but opens nothing, because only
// `http`, `https` and `mailto` may open. So a scheme-less host gets `https://`, and what is
// not an outside address stays plain text. The computer and the phone use the same decision.

/** A host with no scheme: a dotted name or `localhost`, with a port or an end after it. */
const BARE_HOST = /^(?:[\w-]+(?:\.[\w-]+)+|localhost)(?::\d+)?(?:[/?#]|$)/i

/** An address with no scheme: `me@example.com`. It opens as `mailto:`. */
const BARE_MAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/

/**
 * The address that a Markdown link opens, or null when the link opens nothing. A full
 * `http://`, `https://` or `mailto:` address stays as is. A scheme-less host (`www.example.com`
 * or `//example.com/x`) gets `https://` (`localhost` gets `http://`, as in a browser bar), and
 * a bare mail address gets `mailto:`. A relative address (`./file`, `/page`, `#part`), another
 * scheme, or an empty text gives null: the view shows the words of the link as plain text.
 */
export const openableLink = (href: string): string | null => {
  const value = href.trim()
  if (/^(?:https?:\/\/|mailto:)/i.test(value)) return value
  const host = value.startsWith("//") ? value.slice(2) : value
  if (BARE_HOST.test(host)) return /^localhost/i.test(host) ? `http://${host}` : `https://${host}`
  if (!value.startsWith("//") && BARE_MAIL.test(value)) return `mailto:${value}`
  return null
}
