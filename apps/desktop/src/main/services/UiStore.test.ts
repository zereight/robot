import { describe, expect, test } from "bun:test"
import {
  defaultUiState,
  PLACE_LIST_DEFAULT,
  WORKFLOW_SIDE_DEFAULT,
  WORKFLOW_SIDE_MAX,
} from "@robot/shared"
import { Effect, Layer } from "effect"
import { Database, type DatabaseService } from "./Database.ts"
import { UiStore, type UiStoreService } from "./UiStore.ts"

/** Runs a body against one in-memory database, so a test can write rows and read them back. */
const run = <A>(body: (db: DatabaseService, store: UiStoreService) => A): A => {
  const layer = UiStore.layer.pipe(Layer.provideMerge(Database.layer(":memory:")))
  return Effect.runSync(
    Effect.gen(function* () {
      return body(yield* Database, yield* UiStore)
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

describe("UiStore (spec 001)", () => {
  test("starts with the defaults", () => {
    expect(run((_, store) => Effect.runSync(store.get))).toEqual(defaultUiState)
  })

  test("the width of the workflow side column is kept and read back", () => {
    const state = run((_, store) => {
      Effect.runSync(store.update({ workflowSideWidth: 512 }))
      return Effect.runSync(store.get)
    })
    expect(state.workflowSideWidth).toBe(512)
    // The other widths are not touched.
    expect(state.placeListWidth).toBe(PLACE_LIST_DEFAULT)
  })

  test("the view of Agents is kept and read back, and a saved state from before reads as My sections", () => {
    const state = run((db, store) => {
      db.run("INSERT INTO ui_state (key, value) VALUES ('page', '\"workflows\"')")
      const before = Effect.runSync(store.get).agentView
      Effect.runSync(store.update({ agentView: "organization" }))
      return { before, after: Effect.runSync(store.get) }
    })
    expect(state.before).toBe("sections")
    expect(state.after.agentView).toBe("organization")
    expect(state.after.page).toBe("workflows")
  })

  test("an unknown view of Agents reads as My sections", () => {
    const view = run((db, store) => {
      db.run("INSERT INTO ui_state (key, value) VALUES ('agentView', '\"team\"')")
      return Effect.runSync(store.get).agentView
    })
    expect(view).toBe("sections")
  })

  test("a width outside the limits reads as the default", () => {
    const state = run((_, store) => {
      Effect.runSync(store.update({ workflowSideWidth: WORKFLOW_SIDE_MAX + 1 }))
      return Effect.runSync(store.get)
    })
    expect(state.workflowSideWidth).toBe(WORKFLOW_SIDE_DEFAULT)
  })

  test("a saved state from before the column existed reads with the default and keeps its values", () => {
    const state = run((db, store) => {
      // The rows that an earlier version wrote: no row for the workflow side column.
      for (const [key, value] of [
        ["page", "workflows"],
        ["placeListWidth", 300],
        ["activityPanel", false],
      ] as const)
        db.run("INSERT INTO ui_state (key, value) VALUES (?, ?)", key, JSON.stringify(value))
      return Effect.runSync(store.get)
    })
    expect(state.workflowSideWidth).toBe(WORKFLOW_SIDE_DEFAULT)
    expect(state.page).toBe("workflows")
    expect(state.placeListWidth).toBe(300)
    expect(state.activityPanel).toBe(false)
  })
})
