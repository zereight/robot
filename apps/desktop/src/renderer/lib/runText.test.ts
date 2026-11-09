import { describe, expect, test } from "bun:test"
import { type Locale, translate } from "@robot/shared"
import { reasonText } from "./runText.ts"

const t =
  (locale: Locale) =>
  (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(locale, key, params)

describe("the reason of a run", () => {
  test("an engine fault shows the catalogue text with the fault as its detail", () => {
    expect(reasonText(t("en"), "engine", "boom")).toBe("The engine failed: boom")
    expect(reasonText(t("ko"), "engine", "boom")).toBe("엔진에 오류가 생겼어요: boom")
  })

  test("a worktree that could not be made shows the sentence of spec 007", () => {
    expect(reasonText(t("en"), "worktree_failed", "the disk is full")).toBe(
      "Could not make a new worktree: the disk is full",
    )
    expect(reasonText(t("ko"), "worktree_failed", "the disk is full")).toBe(
      "새 워크트리를 만들지 못했어요: the disk is full",
    )
  })

  test("a full queue shows the name of the workflow", () => {
    expect(reasonText(t("en"), "run_queue_full", "Weekly")).toBe(
      "Weekly has 20 tasks that wait. Try again later.",
    )
    expect(reasonText(t("ko"), "run_queue_full", "Weekly")).toBe(
      "Weekly에 대기 중인 작업이 20개 있어요. 나중에 다시 시도해 주세요.",
    )
  })
})
