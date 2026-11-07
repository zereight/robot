import { describe, expect, test } from "bun:test"
import { pastedFiles } from "./paste.ts"

const shot = new File([new Uint8Array([1])], "image.png", { type: "image/png" })
const clip = new File([new Uint8Array([2])], "clip.mov", { type: "video/quicktime" })
const noPath = () => false
const onDisk = (file: File) => file === clip

describe("pastedFiles", () => {
  test("a paste with no file is a text paste", () => {
    expect(pastedFiles([], "hello", noPath)).toEqual([])
    expect(pastedFiles([], "", noPath)).toEqual([])
  })

  test("a screenshot with no text is attached", () => {
    expect(pastedFiles([shot], "", noPath)).toEqual([shot])
  })

  test("a picture or a video with no path is attached, many at once", () => {
    expect(pastedFiles([shot, clip], "", noPath)).toEqual([shot, clip])
  })

  test("a picture that comes with text is a copied table or page: the text wins", () => {
    expect(pastedFiles([shot], "a\tb\n1\t2", noPath)).toEqual([])
  })

  test("a file from the file manager is attached, though its name is on the clipboard as text", () => {
    expect(pastedFiles([clip], "clip.mov", onDisk)).toEqual([clip])
  })

  test("the answer is a copy: the caller can change it", () => {
    const given = [shot]
    expect(pastedFiles(given, "", noPath)).not.toBe(given)
  })
})
