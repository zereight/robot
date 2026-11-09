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

  test("a full queue shows the name of the workflow", () => {
    expect(reasonText(t("en"), "run_queue_full", "Weekly")).toBe(
      "Weekly has 20 tasks that wait. Try again later.",
    )
    expect(reasonText(t("ko"), "run_queue_full", "Weekly")).toBe(
      "Weekly에 대기 중인 작업이 20개 있어요. 나중에 다시 시도해 주세요.",
    )
  })
})
