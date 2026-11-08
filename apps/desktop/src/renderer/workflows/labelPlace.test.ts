import { describe, expect, test } from "bun:test"
import { type LabelBox, labelBox, labelPlace } from "./labelPlace.ts"

const box = (x: number, y: number, w = 176, h = 60) => ({ x, y, w, h })

const overlaps = (a: LabelBox, b: LabelBox) =>
  a.x + a.w > b.x && a.x < b.x + b.w && a.y + a.h > b.y && a.y < b.y + b.h

describe("labelPlace", () => {
  test("between two nodes in a row the label sits above them, not on a border", () => {
    const from = box(240, 24)
    const to = box(456, 24)
    const line = { x1: 416, y1: 54, x2: 456, y2: 54 }
    expect(labelPlace(line, "Approve", [from, to])).toEqual({ x: 436, y: 14 })
  })

  test("with room around the line the label stays by its middle", () => {
    const from = box(24, 24)
    const to = box(456, 24)
    const line = { x1: 200, y1: 54, x2: 456, y2: 54 }
    expect(labelPlace(line, "Approve", [from, to])).toEqual({ x: 328, y: 46 })
  })

  test("a label inside the gap of stacked nodes moves up along its line until it clears them", () => {
    const nodes = [box(240, 24), box(240, 120)]
    const line = { x1: 416, y1: 54, x2: 240, y2: 150 }
    const text = "A longer option label"
    const at = labelPlace(line, text, nodes)
    expect(nodes.some((n) => overlaps(labelBox(at.x, at.y, text), n))).toBe(false)
    expect(at.y).toBeLessThan((line.y1 + line.y2) / 2)
  })
})

describe("the labels of one branch node (spec 010)", () => {
  const lineFor = (from: { x: number; y: number }, to: { x: number; y: number }) => ({
    x1: from.x + 176,
    y1: from.y + 30,
    x2: to.x,
    y2: to.y + 30,
  })
  const placeAll = (nodes: { x: number; y: number }[], edges: [number, string][]) => {
    const boxes = nodes.map((n) => box(n.x, n.y))
    const placed: LabelBox[] = []
    const labels = edges.map(([to, text]) => {
      const from = nodes[0] as { x: number; y: number }
      const target = nodes[to] as { x: number; y: number }
      const at = labelPlace(lineFor(from, target), text, boxes, placed)
      const b = labelBox(at.x, at.y, text)
      placed.push(b)
      return b
    })
    return { boxes, labels }
  }
  const assertClear = (boxes: LabelBox[], labels: LabelBox[]) => {
    for (const l of labels) expect(boxes.some((b) => overlaps(l, b))).toBe(false)
    for (let i = 0; i < labels.length; i++)
      for (let j = i + 1; j < labels.length; j++)
        expect(overlaps(labels[i] as LabelBox, labels[j] as LabelBox)).toBe(false)
  }

  test("an approval node with Approve and Reject to stacked targets: each label clears the other and the nodes", () => {
    const { boxes, labels } = placeAll(
      [
        { x: 240, y: 100 },
        { x: 456, y: 40 },
        { x: 456, y: 160 },
      ],
      [
        [1, "Approve"],
        [2, "Reject"],
      ],
    )
    assertClear(boxes, labels)
  })

  test("a decision node with two options to stacked targets: each label clears the other and the nodes", () => {
    const { boxes, labels } = placeAll(
      [
        { x: 240, y: 100 },
        { x: 456, y: 40 },
        { x: 456, y: 160 },
      ],
      [
        [1, "Yes"],
        [2, "No"],
      ],
    )
    assertClear(boxes, labels)
  })

  test("a decision node with three options to stacked targets: each label clears the others and the nodes", () => {
    const { boxes, labels } = placeAll(
      [
        { x: 240, y: 100 },
        { x: 456, y: 40 },
        { x: 456, y: 160 },
        { x: 456, y: 280 },
      ],
      [
        [1, "Yes"],
        [2, "Maybe"],
        [3, "No"],
      ],
    )
    assertClear(boxes, labels)
  })

  test("two options to the same target: the second label moves past the first", () => {
    const { boxes, labels } = placeAll(
      [
        { x: 240, y: 100 },
        { x: 456, y: 40 },
      ],
      [
        [1, "Yes"],
        [1, "No"],
      ],
    )
    assertClear(boxes, labels)
  })
})
