import { afterEach, describe, expect, test } from "bun:test"
import { clearToasts, dismissToast, showToast, TOAST_MAX, toasts } from "./toast.ts"

afterEach(clearToasts)

describe("toast store", () => {
  test("shows a toast with its tone and text key", () => {
    showToast("success", "workflows.saved")
    expect(toasts().map((t) => [t.tone, t.key])).toEqual([["success", "workflows.saved"]])
  })

  test("a toast goes away when it is dismissed", () => {
    const id = showToast("error", "workflows.saveFailed")
    showToast("success", "workflows.saved")
    dismissToast(id)
    expect(toasts().map((t) => t.key)).toEqual(["workflows.saved"])
  })

  test("keeps at most TOAST_MAX toasts and drops the oldest", () => {
    for (let i = 0; i < TOAST_MAX + 2; i++) showToast("success", "workflows.saved")
    expect(toasts()).toHaveLength(TOAST_MAX)
    const ids = toasts().map((t) => t.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })
})
