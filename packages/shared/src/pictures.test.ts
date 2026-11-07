import { describe, expect, test } from "bun:test"
import {
  createLoadedPictures,
  decidePicture,
  PICTURE_ADDRESS_MAX,
  PICTURE_ALT_MAX,
  pictureKey,
} from "./pictures.ts"

describe("decidePicture", () => {
  test("an https address is a box with a button, and does not load by itself", () => {
    const picture = decidePicture("https://host.test/a.png?d=1", "chart")
    expect(picture.kind).toBe("ask")
    if (picture.kind !== "ask") return
    expect(picture.src).toBe("https://host.test/a.png?d=1")
    expect(picture.box).toEqual({
      alt: "chart",
      altCut: false,
      address: "https://host.test/a.png?d=1",
      addressCut: false,
    })
  })

  test("the scheme is read without regard to case", () => {
    expect(decidePicture("HTTPS://host.test/a.png", "x").kind).toBe("ask")
    expect(decidePicture("DATA:IMAGE/png;base64,AA", "x").kind).toBe("inline")
    expect(decidePicture("HTTP://host.test/a.png", "x").kind).toBe("blocked")
  })

  test("an http address does not load and has no button", () => {
    const picture = decidePicture("http://host.test/a.png", "chart")
    expect(picture).toEqual({
      kind: "blocked",
      box: { alt: "chart", altCut: false, address: "http://host.test/a.png", addressCut: false },
    })
  })

  test("an address that is not a web address does not load", () => {
    for (const href of [
      "",
      "a.png",
      "//host.test/a.png",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://host.test/a.png",
      "data:text/html,x",
      "blob:https://host.test/1",
      "httpsx://host.test/a.png",
    ]) {
      expect(decidePicture(href, "x").kind).toBe("blocked")
    }
  })

  test("a data:image address shows at once, with no box", () => {
    const picture = decidePicture("data:image/png;base64,iVBORw0KGgo=", "dot")
    expect(picture).toEqual({
      kind: "inline",
      src: "data:image/png;base64,iVBORw0KGgo=",
      alt: "dot",
    })
  })

  test("the alt text is cut at 80 characters and the address at 100", () => {
    const alt = "a".repeat(PICTURE_ALT_MAX + 5)
    const address = `https://host.test/${"p".repeat(PICTURE_ADDRESS_MAX)}`
    const picture = decidePicture(address, alt)
    if (picture.kind !== "ask") throw new Error("expected a box")
    expect([...picture.box.alt]).toHaveLength(PICTURE_ALT_MAX)
    expect(picture.box.altCut).toBe(true)
    expect([...picture.box.address]).toHaveLength(PICTURE_ADDRESS_MAX)
    expect(picture.box.address).toBe(address.slice(0, PICTURE_ADDRESS_MAX))
    expect(picture.box.addressCut).toBe(true)
    // The picture itself loads from the whole address.
    expect(picture.src).toBe(address)
  })

  test("a text of exactly the limit is not cut", () => {
    const alt = "b".repeat(PICTURE_ALT_MAX)
    const address = `https://x.test/${"q".repeat(PICTURE_ADDRESS_MAX - 15)}`
    expect([...address]).toHaveLength(PICTURE_ADDRESS_MAX)
    const picture = decidePicture(address, alt)
    if (picture.kind !== "ask") throw new Error("expected a box")
    expect(picture.box.altCut).toBe(false)
    expect(picture.box.addressCut).toBe(false)
  })

  test("a character is a code point: a cut does not split an emoji", () => {
    const alt = "😀".repeat(PICTURE_ALT_MAX + 1)
    const picture = decidePicture("http://x.test/a.png", alt)
    if (picture.kind !== "blocked") throw new Error("expected a box")
    expect(picture.box.alt).toBe("😀".repeat(PICTURE_ALT_MAX))
    expect(picture.box.alt.includes("\uFFFD")).toBe(false)
  })

  test("an empty alt text stays empty: the box shows the word 'Image'", () => {
    for (const alt of ["", "   ", "\n"]) {
      const picture = decidePicture("https://host.test/a.png", alt)
      if (picture.kind !== "ask") throw new Error("expected a box")
      expect(picture.box.alt).toBe("")
    }
  })

  test("line breaks and runs of space in the alt text become one space", () => {
    const picture = decidePicture("https://host.test/a.png", "  a\n\n b\t c ")
    if (picture.kind !== "ask") throw new Error("expected a box")
    expect(picture.box.alt).toBe("a b c")
  })
})

describe("loaded pictures", () => {
  test("a picture is not loaded until the user loads it", () => {
    const loaded = createLoadedPictures()
    expect(loaded.has("m1", "https://host.test/a.png")).toBe(false)
    loaded.load("m1", "https://host.test/a.png")
    expect(loaded.has("m1", "https://host.test/a.png")).toBe(true)
  })

  test("the choice holds for that address in that message only", () => {
    const loaded = createLoadedPictures()
    loaded.load("m1", "https://host.test/a.png")
    expect(loaded.has("m2", "https://host.test/a.png")).toBe(false)
    expect(loaded.has("m1", "https://host.test/b.png")).toBe(false)
    expect(loaded.has("m1", "https://host.test/a.png?x=1")).toBe(false)
  })

  test("a message and an article with the same name do not mix", () => {
    expect(pictureKey("message:1", "https://h.test/a")).not.toBe(
      pictureKey("knowledge:1", "https://h.test/a"),
    )
  })

  test("the listeners hear each new load once", () => {
    const loaded = createLoadedPictures()
    let heard = 0
    const stop = loaded.subscribe(() => {
      heard++
    })
    loaded.load("m1", "https://host.test/a.png")
    loaded.load("m1", "https://host.test/a.png")
    expect(heard).toBe(1)
    stop()
    loaded.load("m1", "https://host.test/b.png")
    expect(heard).toBe(1)
  })

  test("each store starts empty: nothing is kept between runs", () => {
    const first = createLoadedPictures()
    first.load("m1", "https://host.test/a.png")
    expect(createLoadedPictures().has("m1", "https://host.test/a.png")).toBe(false)
  })
})
