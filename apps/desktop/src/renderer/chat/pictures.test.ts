import { describe, expect, test } from "bun:test"
import { decidePicture } from "@robot/shared/pictures"
import type { Token, Tokens } from "marked"
import { lexMarkdown } from "./lex.ts"
import { isPictureLoaded, loadPicture } from "./pictures.ts"

/** The pictures of a Markdown text, in the order of the text, as the view reads them. */
const imagesOf = (text: string) => {
  const found: Tokens.Image[] = []
  const walk = (tokens: readonly Token[] | undefined) => {
    for (const token of tokens ?? []) {
      if (token.type === "image") found.push(token as Tokens.Image)
      else if ("tokens" in token) walk(token.tokens as Token[] | undefined)
      if (token.type === "list") for (const item of (token as Tokens.List).items) walk(item.tokens)
      if (token.type === "table") {
        const table = token as Tokens.Table
        for (const cell of [...table.header, ...table.rows.flat()]) walk(cell.tokens)
      }
    }
  }
  walk(lexMarkdown(text).tokens)
  return found.map((image) => decidePicture(image.href, image.text))
}

describe("the pictures of a Markdown text", () => {
  test("an https picture is a box, an http picture has no button, data:image shows at once", () => {
    const kinds = imagesOf(
      [
        "![chart](https://host.test/a.png?d=1)",
        "![plain](http://host.test/b.png)",
        "![dot](data:image/png;base64,iVBORw0KGgo=)",
      ].join("\n\n"),
    ).map((picture) => picture.kind)
    expect(kinds).toEqual(["ask", "blocked", "inline"])
  })

  test("a picture in a list, a table, a quote, a link and a heading is found and decided too", () => {
    const kinds = imagesOf(
      [
        "- ![a](https://host.test/a.png)",
        "",
        "| x |",
        "| - |",
        "| ![b](https://host.test/b.png) |",
        "",
        "> ![c](https://host.test/c.png)",
        "",
        "[![d](https://host.test/d.png)](https://example.com)",
        "",
        "## ![e](https://host.test/e.png)",
      ].join("\n"),
    ).map((picture) => picture.kind)
    expect(kinds).toEqual(["ask", "ask", "ask", "ask", "ask"])
  })

  test("a picture with a reference address, an address in angle brackets and a title", () => {
    const pictures = imagesOf(
      [
        "![r][ref] ![s](<https://host.test/a b.png>) ![t](https://host.test/t.png 'a title')",
        "",
        "[ref]: https://host.test/ref.png",
      ].join("\n"),
    )
    expect(pictures.map((p) => p.kind)).toEqual(["ask", "ask", "ask"])
    expect(pictures.map((p) => ("src" in p ? p.src : ""))).toEqual([
      "https://host.test/ref.png",
      "https://host.test/a b.png",
      "https://host.test/t.png",
    ])
  })

  test("the alt text is read as it was written", () => {
    const [picture] = imagesOf("![a & b <c> *x*](https://host.test/a.png)")
    if (picture?.kind !== "ask") throw new Error("expected a box")
    expect(picture.box.alt).toBe("a & b <c> *x*")
  })

  test("a picture that is raw HTML is no picture: it shows as text, never loads", () => {
    expect(imagesOf('<img src="https://host.test/a.png">')).toEqual([])
  })
})

describe("the choice to load a picture", () => {
  // The view draws the picture again when the choice changes. The tests of the app check that.
  test("holds for one address in one message", () => {
    const address = "https://host.test/choice.png"
    expect(isPictureLoaded("message:a", address)).toBe(false)
    loadPicture("message:a", address)
    expect(isPictureLoaded("message:a", address)).toBe(true)
    expect(isPictureLoaded("message:b", address)).toBe(false)
    expect(isPictureLoaded("message:a", `${address}?x=1`)).toBe(false)
  })
})
