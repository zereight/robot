import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  clampPanelWidth,
  clampPlaceListWidth,
  clampWorkflowSideWidth,
  defaultUiState,
  PANEL_DEFAULT,
  PANEL_MAX,
  PANEL_MIN,
  UiState,
  WORKFLOW_CANVAS_MIN,
  WORKFLOW_HANDLE_WIDTH,
  WORKFLOW_SIDE_DEFAULT,
  WORKFLOW_SIDE_MAX,
  WORKFLOW_SIDE_MIN,
} from "./ui.ts"

describe("ui state", () => {
  test("defaults are valid, and the app opens on the workflow list", () => {
    expect(Schema.is(UiState)(defaultUiState)).toBe(true)
    expect(defaultUiState.page).toBe("workflows")
  })

  test("the open place is a workflow", () => {
    const state = { ...defaultUiState, places: { s1: { kind: "workflow", id: "w1" } } }
    expect(Schema.is(UiState)(state)).toBe(true)
    expect(Schema.is(UiState)({ ...state, places: { s1: { kind: "agent", id: "a1" } } })).toBe(
      false,
    )
  })

  test("place list width stays between 200 and 400 px", () => {
    expect(clampPlaceListWidth(120)).toBe(200)
    expect(clampPlaceListWidth(512)).toBe(400)
    expect(clampPlaceListWidth(301.4)).toBe(301)
    expect(Schema.is(UiState)({ ...defaultUiState, placeListWidth: 401 })).toBe(false)
  })

  test("the workflow side column keeps its default and stays between its limits", () => {
    expect(defaultUiState.workflowSideWidth).toBe(WORKFLOW_SIDE_DEFAULT)
    expect(
      Schema.is(UiState)({ ...defaultUiState, workflowSideWidth: WORKFLOW_SIDE_MIN - 1 }),
    ).toBe(false)
    expect(
      Schema.is(UiState)({ ...defaultUiState, workflowSideWidth: WORKFLOW_SIDE_MAX + 1 }),
    ).toBe(false)
  })

  test("a width of the workflow side column is clamped to the limits, and rounded", () => {
    expect(clampWorkflowSideWidth(100)).toBe(WORKFLOW_SIDE_MIN)
    expect(clampWorkflowSideWidth(5000)).toBe(WORKFLOW_SIDE_MAX)
    expect(clampWorkflowSideWidth(401.4)).toBe(401)
  })

  test("a small workspace leaves room for the canvas, and never goes under the lowest width", () => {
    expect(clampWorkflowSideWidth(WORKFLOW_SIDE_MAX, 700)).toBe(
      700 - WORKFLOW_CANVAS_MIN - WORKFLOW_HANDLE_WIDTH,
    )
    expect(clampWorkflowSideWidth(WORKFLOW_SIDE_MAX, 300)).toBe(WORKFLOW_SIDE_MIN)
  })

  test("the panel column of the studio keeps its default and stays between 320 and 720 px", () => {
    expect(defaultUiState.panelWidth).toBe(PANEL_DEFAULT)
    expect(clampPanelWidth(100)).toBe(PANEL_MIN)
    expect(clampPanelWidth(5000)).toBe(PANEL_MAX)
    expect(clampPanelWidth(401.4)).toBe(401)
    expect(Schema.is(UiState)({ ...defaultUiState, panelWidth: PANEL_MIN - 1 })).toBe(false)
    expect(Schema.is(UiState)({ ...defaultUiState, panelWidth: PANEL_MAX + 1 })).toBe(false)
  })
})
