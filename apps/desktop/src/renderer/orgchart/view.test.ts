import { describe, expect, test } from "bun:test"
import { buildChart, EMPTY_ORG_SNAPSHOT, type OrgAgent } from "@robot/shared"
import { layoutChart, overlaps } from "./layout.ts"
import {
  clampZoom,
  extent,
  FIT_PADDING,
  fitView,
  toScreen,
  type View,
  wheelFactor,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAt,
} from "./view.ts"

const none = { top: 0, right: 0, bottom: 0, left: 0 }

describe("zoom", () => {
  test("zoom around a point keeps that point where it is", () => {
    const view: View = { x: 40, y: 20, zoom: 0.8 }
    const at = { x: 300, y: 200 }
    // The point of the chart that is under `at` before the zoom.
    const chart = { x: (at.x - view.x) / view.zoom, y: (at.y - view.y) / view.zoom }
    for (const factor of [1.25, 0.8, 2, 0.5]) {
      const next = zoomAt(view, factor, at)
      const after = toScreen(next, chart)
      expect(after.x).toBeCloseTo(at.x, 6)
      expect(after.y).toBeCloseTo(at.y, 6)
    }
  })

  test("the zoom stays between the lowest and the highest step", () => {
    expect(clampZoom(0.001)).toBe(ZOOM_MIN)
    expect(clampZoom(100)).toBe(ZOOM_MAX)
    let view: View = { x: 0, y: 0, zoom: 1 }
    for (let i = 0; i < 60; i++) view = zoomAt(view, 1.25, { x: 10, y: 10 })
    expect(view.zoom).toBe(ZOOM_MAX)
    for (let i = 0; i < 120; i++) view = zoomAt(view, 0.8, { x: 10, y: 10 })
    expect(view.zoom).toBe(ZOOM_MIN)
  })

  test("a turn of the wheel down zooms out, up zooms in, and a pinch is stronger", () => {
    const wheel = { deltaMode: 0, ctrlKey: false }
    expect(wheelFactor({ ...wheel, deltaY: 100 })).toBeLessThan(1)
    expect(wheelFactor({ ...wheel, deltaY: -100 })).toBeGreaterThan(1)
    expect(wheelFactor({ ...wheel, deltaY: 0 })).toBe(1)
    const pinch = wheelFactor({ ...wheel, ctrlKey: true, deltaY: -5 })
    const turn = wheelFactor({ ...wheel, deltaY: -5 })
    expect(pinch).toBeGreaterThan(turn)
    // A wheel that counts in lines moves as 16 px for each line.
    expect(wheelFactor({ deltaMode: 1, ctrlKey: false, deltaY: 3 })).toBeCloseTo(
      wheelFactor({ deltaMode: 0, ctrlKey: false, deltaY: 48 }),
      9,
    )
  })
})

describe("Fit to view", () => {
  const canvas = { w: 1000, h: 600 }

  test("a chart that is larger than the canvas shrinks to fit, with room around it", () => {
    const box = { x: 100, y: 50, w: 4000, h: 2400 }
    const view = fitView(box, canvas, none)
    expect(view.zoom).toBeLessThan(1)
    const a = toScreen(view, { x: box.x, y: box.y })
    const b = toScreen(view, { x: box.x + box.w, y: box.y + box.h })
    expect(a.x).toBeGreaterThanOrEqual(FIT_PADDING - 1e-6)
    expect(a.y).toBeGreaterThanOrEqual(FIT_PADDING - 1e-6)
    expect(b.x).toBeLessThanOrEqual(canvas.w - FIT_PADDING + 1e-6)
    expect(b.y).toBeLessThanOrEqual(canvas.h - FIT_PADDING + 1e-6)
  })

  test("a small chart is not made larger than 100%, and sits in the middle", () => {
    const box = { x: 0, y: 0, w: 200, h: 100 }
    const view = fitView(box, canvas, none)
    expect(view.zoom).toBe(1)
    const a = toScreen(view, { x: 0, y: 0 })
    const b = toScreen(view, { x: 200, y: 100 })
    expect((a.x + b.x) / 2).toBeCloseTo(canvas.w / 2, 6)
    expect((a.y + b.y) / 2).toBeCloseTo(canvas.h / 2, 6)
  })

  test("no node sits under the controls at the bottom right", () => {
    // The controls take a strip of 56 px at the bottom, and 160 px at the right in the corner.
    const controls = { x: canvas.w - 160 - 16, y: canvas.h - 56 - 16, w: 160, h: 56 }
    const box = { x: 0, y: 0, w: 5000, h: 3000 }
    const view = fitView(box, canvas, { ...none, bottom: 56 + 2 * 16 })
    const corner = toScreen(view, { x: box.w, y: box.h })
    const drawn = { x: corner.x - 10, y: corner.y - 10, w: 10, h: 10 }
    expect(overlaps(drawn, controls)).toBe(false)
    expect(corner.y).toBeLessThanOrEqual(controls.y)
  })

  test("a canvas that is smaller than the insets still gives a zoom and a place", () => {
    const view = fitView({ x: 0, y: 0, w: 500, h: 500 }, { w: 40, h: 40 }, { ...none, bottom: 100 })
    expect(Number.isFinite(view.x) && Number.isFinite(view.y)).toBe(true)
    expect(view.zoom).toBeGreaterThanOrEqual(ZOOM_MIN)
  })

  test("an empty box gives the place of the padding at 100%", () => {
    expect(fitView({ x: 0, y: 0, w: 0, h: 0 }, canvas, none)).toEqual({
      x: FIT_PADDING,
      y: FIT_PADDING,
      zoom: 1,
    })
  })
})

describe("the extent of a layout", () => {
  const agent = (id: string): OrgAgent => ({
    id,
    name: id,
    role: "",
    face: { shape: 0, hue: 0 },
    state: "idle",
    task: null,
  })

  test("it holds every node, every corner of a line and every number", () => {
    const model = buildChart({
      ...EMPTY_ORG_SNAPSHOT,
      agents: ["a", "b", "c", "d"].map(agent),
      channels: [
        { id: "x", name: "X", createdAt: 1, leadId: "a", memberIds: ["a", "b"] },
        { id: "y", name: "Y", createdAt: 2, leadId: null, memberIds: ["c", "d"] },
      ],
      handoffs: [
        { from: "a", to: "c", count: 12, newest: 3 },
        { from: "d", to: "b", count: 3, newest: 4 },
      ],
    })
    const layout = layoutChart(model, 14)
    const box = extent(layout)
    const inside = (p: { x: number; y: number }) =>
      p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h
    for (const n of layout.nodes) {
      expect(inside({ x: n.rect.x, y: n.rect.y })).toBe(true)
      expect(inside({ x: n.rect.x + n.rect.w, y: n.rect.y + n.rect.h })).toBe(true)
    }
    for (const line of layout.lines) {
      for (const p of line.points) expect(inside(p)).toBe(true)
      if (line.label) {
        expect(inside({ x: line.label.x, y: line.label.y })).toBe(true)
        expect(inside({ x: line.label.x + line.label.w, y: line.label.y + line.label.h })).toBe(
          true,
        )
      }
    }
  })
})
