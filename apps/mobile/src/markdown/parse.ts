import { decidePicture, type Picture } from "@robot/shared/pictures"
import { marked, type Token, type Tokens } from "marked"

// Markdown of a reply as a small, safe tree that the screen draws with native views (spec 003).
// Rules (docs/spec-questions.md, 003): raw HTML shows as plain text, a link opens only for http,
// https and mailto, and a picture from the web is a box until the user loads it (decidePicture).

export interface Style {
  readonly bold?: boolean
  readonly italic?: boolean
  readonly strike?: boolean
  readonly code?: boolean
}

export type Inline =
  | { readonly kind: "text"; readonly text: string; readonly style: Style }
  | { readonly kind: "link"; readonly href: string; readonly children: readonly Inline[] }
  | { readonly kind: "image"; readonly picture: Picture }
  | { readonly kind: "break" }

export type Block =
  | { readonly kind: "paragraph"; readonly inlines: readonly Inline[] }
  | { readonly kind: "heading"; readonly level: number; readonly inlines: readonly Inline[] }
  | { readonly kind: "code"; readonly lang: string; readonly text: string }
  | { readonly kind: "quote"; readonly blocks: readonly Block[] }
  | {
      readonly kind: "list"
      readonly ordered: boolean
      readonly start: number
      readonly items: readonly (readonly Block[])[]
    }
  | {
      readonly kind: "table"
      readonly header: readonly (readonly Inline[])[]
      readonly rows: readonly (readonly (readonly Inline[])[])[]
    }
  | { readonly kind: "rule" }

/** A link that the phone may open: http, https and mailto only. */
export const safeLink = (href: string): string | null => {
  const value = href.trim()
  return /^(https?:\/\/|mailto:)/i.test(value) ? value : null
}

const plain = (text: string, style: Style): Inline => ({ kind: "text", text, style })

const inlines = (tokens: readonly Token[] | undefined, style: Style = {}): Inline[] =>
  (tokens ?? []).flatMap((token): Inline[] => {
    switch (token.type) {
      case "strong":
        return inlines((token as Tokens.Strong).tokens, { ...style, bold: true })
      case "em":
        return inlines((token as Tokens.Em).tokens, { ...style, italic: true })
      case "del":
        return inlines((token as Tokens.Del).tokens, { ...style, strike: true })
      case "codespan":
        return [plain(decode((token as Tokens.Codespan).text), { ...style, code: true })]
      case "br":
        return [{ kind: "break" }]
      case "link": {
        const t = token as Tokens.Link
        const href = safeLink(t.href)
        const children = inlines(t.tokens, style)
        if (!href) return children
        // A picture in a link stands on its own line, as a box, so that the user can load it.
        // The link keeps its text.
        const pictures = children.filter((child) => child.kind === "image")
        const words = children.filter((child) => child.kind !== "image")
        return [
          ...(words.length > 0 ? [{ kind: "link" as const, href, children: words }] : []),
          ...pictures,
        ]
      }
      case "image": {
        const t = token as Tokens.Image
        return [{ kind: "image", picture: decidePicture(t.href, t.text) }]
      }
      case "text": {
        const t = token as Tokens.Text
        return t.tokens && t.tokens.length > 0
          ? inlines(t.tokens, style)
          : [plain(decode(t.text), style)]
      }
      case "escape":
        return [plain((token as Tokens.Escape).text, style)]
      // Raw HTML is text: the user sees the tags, nothing runs or loads.
      case "html":
        return [plain(token.raw, style)]
      default:
        return [plain(token.raw, style)]
    }
  })

const blocks = (tokens: readonly Token[]): Block[] =>
  tokens.flatMap((token): Block[] => {
    switch (token.type) {
      case "space":
        return []
      case "paragraph":
        return [{ kind: "paragraph", inlines: inlines((token as Tokens.Paragraph).tokens) }]
      case "text": {
        const t = token as Tokens.Text
        return [{ kind: "paragraph", inlines: t.tokens ? inlines(t.tokens) : [plain(t.text, {})] }]
      }
      case "heading": {
        const t = token as Tokens.Heading
        return [{ kind: "heading", level: t.depth, inlines: inlines(t.tokens) }]
      }
      case "code": {
        const t = token as Tokens.Code
        return [{ kind: "code", lang: t.lang ?? "", text: t.text }]
      }
      case "blockquote":
        return [{ kind: "quote", blocks: blocks((token as Tokens.Blockquote).tokens) }]
      case "list": {
        const t = token as Tokens.List
        return [
          {
            kind: "list",
            ordered: t.ordered,
            start: typeof t.start === "number" ? t.start : 1,
            items: t.items.map((item) => blocks(item.tokens)),
          },
        ]
      }
      case "table": {
        const t = token as Tokens.Table
        return [
          {
            kind: "table",
            header: t.header.map((cell) => inlines(cell.tokens)),
            rows: t.rows.map((row) => row.map((cell) => inlines(cell.tokens))),
          },
        ]
      }
      case "hr":
        return [{ kind: "rule" }]
      case "html":
        return [{ kind: "paragraph", inlines: [plain(token.raw.trimEnd(), {})] }]
      default:
        return token.raw.trim() ? [{ kind: "paragraph", inlines: [plain(token.raw, {})] }] : []
    }
  })

/** Undoes the entities that the lexer of marked writes into text (it escapes for HTML). */
const decode = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")

/** The Markdown of a reply as blocks. */
export const parseMarkdown = (text: string): Block[] =>
  blocks(marked.lexer(text, { gfm: true, breaks: false }))
