import { describe, expect, test } from "bun:test"
import { type Block, type Inline, parseMarkdown, safeImage, safeLink } from "./parse.ts"

const textOf = (list: readonly Inline[]): string =>
  list
    .map((i) =>
      i.kind === "text"
        ? i.text
        : i.kind === "link"
          ? textOf(i.children)
          : i.kind === "image"
            ? `[img ${i.alt}]`
            : "\n",
    )
    .join("")

const first = (text: string) => parseMarkdown(text)[0] as Block

describe("markdown of a reply", () => {
  test("headings, lists, code, quotes, tables and rules", () => {
    const out = parseMarkdown(
      "# Title\n\n- one\n- **two**\n\n1. a\n2. b\n\n```ts\nconst x = 1 < 2\n```\n\n> said\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n---",
    )
    expect(out.map((b) => b.kind)).toEqual([
      "heading",
      "list",
      "list",
      "code",
      "quote",
      "table",
      "rule",
    ])
    expect(out[0]).toMatchObject({ kind: "heading", level: 1 })
    expect(out[3]).toEqual({ kind: "code", lang: "ts", text: "const x = 1 < 2" })
    const table = out[5] as Extract<Block, { kind: "table" }>
    expect(table.header.map(textOf)).toEqual(["a", "b"])
    expect(table.rows.map((r) => r.map(textOf))).toEqual([["1", "2"]])
    const list = out[1] as Extract<Block, { kind: "list" }>
    const second = list.items[1]?.[0] as Extract<Block, { kind: "paragraph" }>
    expect(second.inlines[0]).toMatchObject({ kind: "text", text: "two", style: { bold: true } })
  })

  test("raw HTML shows as plain text", () => {
    const block = first("Hi <img src=x onerror=alert(1)> there") as Extract<
      Block,
      { kind: "paragraph" }
    >
    expect(textOf(block.inlines)).toBe("Hi <img src=x onerror=alert(1)> there")
    const html = first("<script>alert(1)</script>") as Extract<Block, { kind: "paragraph" }>
    expect(textOf(html.inlines)).toBe("<script>alert(1)</script>")
  })

  test("text with & and < reads as typed", () => {
    const block = first("a & b < c `x<y`") as Extract<Block, { kind: "paragraph" }>
    expect(textOf(block.inlines)).toBe("a & b < c x<y")
  })

  test("links open only for http, https and mailto", () => {
    const block = first(
      "[a](https://example.com) [b](mailto:me@example.com) [c](javascript:alert(1)) [d](file:///etc/passwd) [e](http://x.test)",
    ) as Extract<Block, { kind: "paragraph" }>
    const links = block.inlines.filter((i) => i.kind === "link").map((i) => i.href)
    expect(links).toEqual(["https://example.com", "mailto:me@example.com", "http://x.test"])
    expect(textOf(block.inlines)).toContain("c")
    expect(safeLink(" JAVASCRIPT:alert(1)")).toBeNull()
    expect(safeLink("data:text/html,x")).toBeNull()
  })

  test("images load only from https", () => {
    const block = first(
      "![cat](https://e.com/c.png) ![dog](http://e.com/d.png) ![x](data:image/png;base64,AA)",
    ) as Extract<Block, { kind: "paragraph" }>
    const images = block.inlines.filter((i) => i.kind === "image")
    expect(images).toEqual([{ kind: "image", src: "https://e.com/c.png", alt: "cat" }])
    expect(textOf(block.inlines)).toContain("dog")
    expect(safeImage("file:///x.png")).toBeNull()
  })
})
