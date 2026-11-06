import { afterEach, describe, expect, test } from "bun:test"
import { clearToasts, dismissToast, showToast, TOAST_MAX, toasts } from "./toast.ts"

afterEach(clearToasts)

describe("toast store", () => {
  test("shows a toast with its tone and text key", () => {
    showToast("success", "skills.saved")
    expect(toasts().map((t) => [t.tone, t.key])).toEqual([["success", "skills.saved"]])
  })

  test("a toast goes away when it is dismissed", () => {
    const id = showToast("error", "skills.duplicated")
    showToast("success", "skills.saved")
    dismissToast(id)
    expect(toasts().map((t) => t.key)).toEqual(["skills.saved"])
  })

  test("keeps at most TOAST_MAX toasts and drops the oldest", () => {
    for (let i = 0; i < TOAST_MAX + 2; i++) showToast("success", "skills.saved")
    expect(toasts()).toHaveLength(TOAST_MAX)
    const ids = toasts().map((t) => t.id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
  })
})
