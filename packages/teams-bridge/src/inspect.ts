import type { Page } from "playwright-core"

export interface PageShape {
  url: string
  dataTidCounts: Record<string, number>
  editable: { tag: string; dataTid: string | null; role: string | null; ariaLabelLength: number }[]
  elementsWithDataMid: { tag: string; dataTid: string | null; childTids: (string | null)[] }[]
  titleLike: { dataTid: string | null; tag: string; textLength: number }[]
}

/**
 * Describes the page so that src/selectors.ts can be fixed.
 * It returns attribute values and counts only. It returns no message text.
 */
export async function describePage(page: Page): Promise<PageShape> {
  // This callback runs in the browser. It can use only its own arguments, not outer variables.
  return page.evaluate(() => {
    const tids = new Map<string, number>()
    document.querySelectorAll("[data-tid]").forEach((el) => {
      const v = el.getAttribute("data-tid") ?? ""
      tids.set(v, (tids.get(v) ?? 0) + 1)
    })
    return {
      url: location.origin + location.pathname,
      dataTidCounts: Object.fromEntries(
        [...tids.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80),
      ),
      editable: Array.from(document.querySelectorAll('[contenteditable="true"]')).map((el) => ({
        tag: el.tagName.toLowerCase(),
        dataTid: el.getAttribute("data-tid"),
        role: el.getAttribute("role"),
        ariaLabelLength: (el.getAttribute("aria-label") ?? "").length,
      })),
      elementsWithDataMid: Array.from(document.querySelectorAll("[data-mid]"))
        .slice(0, 3)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          dataTid: el.getAttribute("data-tid"),
          childTids: Array.from(el.querySelectorAll("[data-tid]")).map((c) =>
            c.getAttribute("data-tid"),
          ),
        })),
      titleLike: Array.from(document.querySelectorAll("[data-tid]"))
        .filter((el) => /title|header/i.test(el.getAttribute("data-tid") ?? ""))
        .map((el) => ({
          dataTid: el.getAttribute("data-tid"),
          tag: el.tagName.toLowerCase(),
          // biome-ignore lint/performance/useDomNodeTextContent: the length of the text as the user sees it
          textLength: (el as HTMLElement).innerText.trim().length,
        })),
    }
  })
}
