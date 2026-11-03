import { describe, expect, test } from "bun:test"
import { type Block, type Inline, parseMarkdown, safeLink } from "./parse.ts"

const textOf = (list: readonly Inline[]): string =>
  list
    .map((i) =>
      i.kind === "text"
        ? i.text
        : i.kind === "link"
          ? textOf(i.children)
          : i.kind === "image"
            ? `[img ${i.picture.kind === "inline" ? i.picture.alt : i.picture.box.alt}]`
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

  test("a picture from the web is a box until the user loads it (spec 003)", () => {
    const block = first(
      "![cat](https://e.com/c.png) ![dog](http://e.com/d.png) ![x](data:image/png;base64,AA)",
    ) as Extract<Block, { kind: "paragraph" }>
    const pictures = block.inlines.flatMap((i) => (i.kind === "image" ? [i.picture] : []))
    expect(pictures.map((p) => p.kind)).toEqual(["ask", "blocked", "inline"])
    // https: a box with the alt text and the address. The picture loads from the whole address.
    expect(pictures[0]).toEqual({
      kind: "ask",
      src: "https://e.com/c.png",
      alt: "cat",
      box: { alt: "cat", altCut: false, address: "https://e.com/c.png", addressCut: false },
    })
    // http: the box has no button, so the picture never loads.
    expect(pictures[1]).toEqual({
      kind: "blocked",
      box: { alt: "dog", altCut: false, address: "http://e.com/d.png", addressCut: false },
    })
    // data:image: the data is in the text, so it shows at once.
    expect(pictures[2]).toEqual({ kind: "inline", src: "data:image/png;base64,AA", alt: "x" })
  })

  test("an address that is not a web address does not load", () => {
    const block = first(
      "![a](file:///etc/passwd) ![b](javascript:alert(1)) ![c](rel.png)",
    ) as Extract<Block, { kind: "paragraph" }>
    const pictures = block.inlines.flatMap((i) => (i.kind === "image" ? [i.picture] : []))
    expect(pictures.map((p) => p.kind)).toEqual(["blocked", "blocked", "blocked"])
  })

  test("the alt text is cut at 80 characters and the address at 100", () => {
    const alt = "a".repeat(90)
    const address = `https://e.com/${"p".repeat(120)}`
    const block = first(`![${alt}](${address})`) as Extract<Block, { kind: "paragraph" }>
    const picture = block.inlines.find((i) => i.kind === "image")
    if (picture?.kind !== "image" || picture.picture.kind !== "ask") throw new Error("no box")
    expect([...picture.picture.box.alt]).toHaveLength(80)
    expect(picture.picture.box.altCut).toBe(true)
    expect([...picture.picture.box.address]).toHaveLength(100)
    expect(picture.picture.box.addressCut).toBe(true)
    expect(picture.picture.src).toBe(address)
  })

  test("an empty alt text stays empty: the box shows the word for it", () => {
    const block = first("![](https://e.com/c.png)") as Extract<Block, { kind: "paragraph" }>
    const picture = block.inlines.find((i) => i.kind === "image")
    if (picture?.kind !== "image" || picture.picture.kind !== "ask") throw new Error("no box")
    expect(picture.picture.box.alt).toBe("")
  })

  test("a picture in a table cell, a list, a quote and a heading is decided too", () => {
    const count = (blocks: readonly Block[]): number =>
      blocks.reduce((sum, block) => {
        const here = (inlines: readonly Inline[]) =>
          inlines.filter((i) => i.kind === "image" && i.picture.kind === "ask").length
        if (block.kind === "paragraph" || block.kind === "heading") return sum + here(block.inlines)
        if (block.kind === "quote") return sum + count(block.blocks)
        if (block.kind === "list") return sum + block.items.reduce((n, item) => n + count(item), 0)
        if (block.kind === "table")
          return sum + [block.header, ...block.rows].flat().reduce((n, cell) => n + here(cell), 0)
        return sum
      }, 0)
    const out = parseMarkdown(
      [
        "- ![a](https://e.com/a.png)",
        "",
        "| x |",
        "| - |",
        "| ![b](https://e.com/b.png) |",
        "",
        "> ![c](https://e.com/c.png)",
        "",
        "## ![d](https://e.com/d.png)",
      ].join("\n"),
    )
    expect(count(out)).toBe(4)
  })

  test("a picture in a link is a box of its own, and the link keeps its text", () => {
    const block = first("[docs ![badge](https://e.com/b.png)](https://example.com)") as Extract<
      Block,
      { kind: "paragraph" }
    >
    const link = block.inlines.find((i) => i.kind === "link")
    expect(link?.kind === "link" && textOf(link.children)).toBe("docs ")
    expect(block.inlines.filter((i) => i.kind === "image")).toHaveLength(1)
    // A link with only a picture leaves no empty link.
    const only = first("[![badge](https://e.com/b.png)](https://example.com)") as Extract<
      Block,
      { kind: "paragraph" }
    >
    expect(only.inlines.map((i) => i.kind)).toEqual(["image"])
  })

  test("raw HTML with an image tag is text and loads nothing", () => {
    const block = first('<img src="https://e.com/a.png">') as Extract<Block, { kind: "paragraph" }>
    expect(block.inlines.some((i) => i.kind === "image")).toBe(false)
    expect(textOf(block.inlines)).toContain("<img")
  })
})
