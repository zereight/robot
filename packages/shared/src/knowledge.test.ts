import { describe, expect, test } from "bun:test"
import { MESSAGE_MAX } from "./chat.ts"
import { translate } from "./i18n/index.ts"
import {
  articleFileName,
  articleLimit,
  articleLinks,
  checkMessage,
  cleanLine,
  contentsLine,
  contentsList,
  formatArticleFile,
  KNOWLEDGE_CHARS_MAX,
  KNOWLEDGE_LINES_MAX,
  knowledgeFindings,
  parseArticleFile,
  sourceFileName,
  titleKey,
  withLinks,
} from "./knowledge.ts"

describe("limits", () => {
  test("title 1 to 80, summary up to 160, body up to 20,000", () => {
    expect(articleLimit("", "", "")).toBe("knowledge_title_invalid")
    expect(articleLimit("   ", "", "")).toBe("knowledge_title_invalid")
    expect(articleLimit("a".repeat(80), "", "")).toBeNull()
    expect(articleLimit("a".repeat(81), "", "")).toBe("knowledge_title_invalid")
    expect(articleLimit("t", "s".repeat(160), "")).toBeNull()
    expect(articleLimit("t", "s".repeat(161), "")).toBe("knowledge_summary_long")
    expect(articleLimit("t", "", "b".repeat(20_000))).toBeNull()
    expect(articleLimit("t", "", "b".repeat(20_001))).toBe("knowledge_body_long")
  })

  test("length counts characters a person sees, not UTF-16 units", () => {
    expect(articleLimit("😀".repeat(80), "", "")).toBeNull()
    expect(articleLimit("😀".repeat(81), "", "")).toBe("knowledge_title_invalid")
  })

  test("the title key ignores case, spaces and normal form", () => {
    expect(titleKey("  Vite   Config ")).toBe(titleKey("vite config"))
    expect(titleKey("Café")).toBe(titleKey("Cafe\u0301"))
    expect(cleanLine("a\n b\t c")).toBe("a b c")
  })
})

describe("article files", () => {
  test("a file is read back as it was written", () => {
    const text = formatArticleFile({
      title: "Vite config",
      summary: "How the build is set up.",
      body: "# Build\n\nSee [[Deploy]].\n\n---\n\nEnd.",
      sources: ["report.pdf", "notes (2).txt"],
      extra: ["tags: build"],
    })
    expect(parseArticleFile("Vite config.md", text)).toEqual({
      title: "Vite config",
      summary: "How the build is set up.",
      body: "# Build\n\nSee [[Deploy]].\n\n---\n\nEnd.",
      sources: ["report.pdf", "notes (2).txt"],
      extra: ["tags: build"],
    })
  })

  test("a file with no header is an article: file name, first line, whole text", () => {
    const parsed = parseArticleFile("Idea.md", "A plain note.\nMore.\n")
    expect(parsed.title).toBe("Idea")
    expect(parsed.summary).toBe("A plain note.")
    expect(parsed.body).toBe("A plain note.\nMore.")
    expect(parsed.sources).toEqual([])
    // The first line is the first line: a heading is not skipped. Empty lines before it are.
    expect(parseArticleFile("Idea.md", "\n\n# Idea\n\nA plain note.\n").summary).toBe("# Idea")
  })

  test("a header with no title and no summary is the same: file name and first line", () => {
    const parsed = parseArticleFile(
      "Trip.md",
      "---\ntags: travel\n---\n\nPacking list for the trip.\n",
    )
    expect(parsed).toMatchObject({
      title: "Trip",
      summary: "Packing list for the trip.",
      body: "Packing list for the trip.",
      extra: ["tags: travel"],
    })
    // A header that names a title or a summary, even an empty one, is not changed.
    expect(parseArticleFile("T.md", "---\ntitle: Own\n---\n\nText.\n")).toMatchObject({
      title: "Own",
      summary: "",
    })
    expect(parseArticleFile("T.md", "---\nsummary:\n---\n\nText.\n")).toMatchObject({
      title: "T",
      summary: "",
    })
  })

  test("a file from another app has no limits: a long title, summary and body are read as they are", () => {
    const parsed = parseArticleFile(
      "x.md",
      `---\ntitle: ${"t".repeat(300)}\nsummary: ${"s".repeat(400)}\n---\n\n${"b".repeat(30_000)}\n`,
    )
    expect(parsed.title).toHaveLength(300)
    expect(parsed.summary).toHaveLength(400)
    expect(parsed.body).toHaveLength(30_000)
  })

  test("line endings of Windows and a byte order mark do not matter", () => {
    const parsed = parseArticleFile(
      "x.md",
      "\uFEFF---\r\ntitle: T\r\nsummary: S\r\n---\r\n\r\nBody\r\n",
    )
    expect(parsed).toMatchObject({ title: "T", summary: "S", body: "Body" })
  })

  test("a header that never closes is part of the text", () => {
    expect(parseArticleFile("x.md", "---\ntitle: T\nBody").title).toBe("x")
  })
})

describe("links", () => {
  test("links are the titles in [[double brackets]], each once", () => {
    expect(articleLinks("See [[A]] and [[ b ]] and [[a]] and [[]].")).toEqual(["A", "b"])
  })

  test("links that the body does not name yet are added to its end", () => {
    expect(withLinks("Text [[A]].", ["a", "B"])).toBe("Text [[A]].\n\nSee also: [[B]]")
    expect(withLinks("Text.", [])).toBe("Text.")
  })
})

describe("file names", () => {
  const none = () => false
  test("unsafe characters go and the name ends in .md", () => {
    expect(articleFileName("a/b:c?", none)).toBe("a b c.md")
    expect(articleFileName("..hidden.", none)).toBe("hidden.md")
    expect(articleFileName("한글 제목", none)).toBe("한글 제목.md")
    expect(articleFileName("///", none)).toBe("article.md")
    expect(articleFileName("CON", none)).toBe("CON_.md")
  })

  test("a taken name gets a number", () => {
    const taken = new Set(["a.md", "a (2).md"])
    expect(articleFileName("a", (n) => taken.has(n))).toBe("a (3).md")
  })

  test("a source name has no path", () => {
    expect(sourceFileName("../../etc/passwd", none)).toBe("passwd")
    expect(sourceFileName("C:\\dir\\report.pdf", none)).toBe("report.pdf")
    const taken = new Set(["report.pdf"])
    expect(sourceFileName("report.pdf", (n) => taken.has(n))).toBe("report (2).pdf")
  })
})

describe("contents list", () => {
  const entry = (n: number, summary = "summary", updatedAt = n) => ({
    title: `Article ${String(n).padStart(3, "0")}`,
    summary,
    updatedAt,
  })

  test("a list that fits is given whole, by title", () => {
    const { lines, omitted } = contentsList([entry(2), entry(1)], "anything")
    expect(lines).toEqual(["- Article 001: summary", "- Article 002: summary"])
    expect(omitted).toBe(0)
    expect(contentsLine({ title: "T", summary: "", updatedAt: 0 })).toBe("- T")
  })

  test("at most 100 lines with the note; words of the message first, then the newest", () => {
    const entries = Array.from({ length: 150 }, (_, i) => entry(i + 1))
    // Article 007 is old, but the message names its words.
    entries[6] = { title: "Deploy pipeline", summary: "steps of the release", updatedAt: 0 }
    const { lines, omitted, note } = contentsList(entries, "How does the deploy pipeline work?")
    // The line that says how many are left out counts as one of the 100.
    expect(lines).toHaveLength(KNOWLEDGE_LINES_MAX - 1)
    expect(omitted).toBe(51)
    expect(note).toBe("(51 more articles are not in this list.)")
    expect(lines[0]).toBe("- Deploy pipeline: steps of the release")
    // The rest are the newest: 150 down.
    expect(lines[1]).toBe("- Article 150: summary")
    expect(lines).not.toContain("- Article 001: summary")
  })

  test("100 articles fit whole and have no note; 101 do not", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => entry(i + 1))
    const whole = contentsList(hundred, "")
    expect(whole.lines).toHaveLength(100)
    expect(whole.omitted).toBe(0)
    expect(whole.note).toBeNull()
    const more = contentsList([...hundred, entry(101)], "")
    expect(more.lines.length + 1).toBeLessThanOrEqual(KNOWLEDGE_LINES_MAX)
    expect(more.omitted).toBe(101 - more.lines.length)
    expect(more.note).toContain(String(more.omitted))
  })

  test("the lines that share words come first, whatever their age; the others follow, newest first", () => {
    const entries = Array.from({ length: 120 }, (_, i) => entry(i + 1))
    entries[0] = { title: "Old fox", summary: "the red fox", updatedAt: -5 }
    entries[1] = { title: "Older fox", summary: "another fox note", updatedAt: -9 }
    const { lines } = contentsList(entries, "tell me about the fox")
    expect(lines.slice(0, 2)).toEqual(["- Old fox: the red fox", "- Older fox: another fox note"])
    expect(lines[2]).toBe("- Article 120: summary")
  })

  test("at most 6,000 characters with the note", () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(i + 1, "x".repeat(150)))
    const { lines, note } = contentsList(entries, "")
    const size = [...lines, note ?? ""].reduce((sum, l) => sum + l.length + 1, 0)
    expect(size).toBeLessThanOrEqual(KNOWLEDGE_CHARS_MAX)
    expect(lines.length).toBeLessThan(60)
    expect(lines[0]).toContain("Article 060")
    expect(note).not.toBeNull()
  })

  test("a line that does not fit is left out; shorter lines after it still come", () => {
    const entries = Array.from({ length: 120 }, (_, i) => entry(i + 1))
    // Another app wrote a title longer than the whole list may be. It is the newest.
    entries.push({ title: "T".repeat(7000), summary: "", updatedAt: 1e9 })
    const { lines, omitted } = contentsList(entries, "")
    expect(lines.some((l) => l.includes("TTTT"))).toBe(false)
    expect(lines[0]).toBe("- Article 120: summary")
    expect(lines).toHaveLength(KNOWLEDGE_LINES_MAX - 1)
    expect(omitted).toBe(121 - lines.length)
  })

  test("a summary longer than the limit is cut in the list, not the title", () => {
    expect(contentsLine({ title: "T", summary: "s".repeat(400), updatedAt: 0 })).toBe(
      `- T: ${"s".repeat(160)}`,
    )
  })

  test("a word also matches a Korean noun with a particle", () => {
    const entries = Array.from({ length: 120 }, (_, i) => entry(i + 1))
    entries[0] = { title: "배포 절차", summary: "릴리스 순서", updatedAt: 0 }
    expect(contentsList(entries, "배포는 어떻게 해?").lines[0]).toBe("- 배포 절차: 릴리스 순서")
  })
})

describe("findings", () => {
  test("broken links, articles nobody links to, articles with no source", () => {
    const found = knowledgeFindings([
      { title: "A", body: "See [[B]] and [[Gone]].", sources: ["s.txt"] },
      { title: "B", body: "Back to [[a]].", sources: [] },
      { title: "C", body: "Alone [[C]].", sources: [] },
    ])
    expect(found.missingLinks).toEqual([{ from: "A", to: "Gone" }])
    expect(found.unlinked).toEqual(["C"])
    expect(found.noSource).toEqual(["B", "C"])
  })

  test("one article alone is not reported as unlinked", () => {
    expect(knowledgeFindings([{ title: "A", body: "", sources: [] }]).unlinked).toEqual([])
  })
})

describe("the message of Check knowledge", () => {
  const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate("en", key, params)
  const ko = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate("ko", key, params)

  test("the findings come first; then the request to read all articles and to add statements that disagree", () => {
    const text = checkMessage(en, {
      missingLinks: [{ from: "A", to: "Gone" }],
      unlinked: ["C"],
      noSource: ["B", "C"],
    })
    expect(text).toBe(
      [
        "Check knowledge.",
        [
          "The app found this:",
          "- A links to Gone. This article does not exist.",
          "- No other article links to C.",
          "- B has no source.",
          "- C has no source.",
        ].join("\n"),
        "Read all articles. Find statements that disagree, and add them to a report with what the app found. Change nothing until I say so.",
      ].join("\n\n"),
    )
  })

  test("with nothing found, the message says so and still asks for the read", () => {
    const text = checkMessage(en, { missingLinks: [], unlinked: [], noSource: [] })
    expect(text).toContain("The app found no broken link")
    expect(text).toContain("Read all articles.")
    expect(text).not.toContain("The app found this:")
  })

  test("every finding is in the message, also past 100 lines", () => {
    const noSource = Array.from({ length: 500 }, (_, i) => `Article ${i}`)
    const text = checkMessage(en, { missingLinks: [], unlinked: [], noSource })
    expect(text.match(/has no source\./g)).toHaveLength(500)
    expect(text).not.toContain("more findings")
    expect(text.length).toBeLessThan(MESSAGE_MAX)
  })

  test("only a message that cannot fit in a chat message is cut, and the cut is said", () => {
    const missingLinks = Array.from({ length: 4000 }, (_, i) => ({
      from: `Article ${i} ${"x".repeat(40)}`,
      to: `Gone ${i} ${"y".repeat(40)}`,
    }))
    const text = checkMessage(en, { missingLinks, unlinked: [], noSource: [] })
    expect(text.length).toBeLessThan(MESSAGE_MAX)
    expect(text).toMatch(/- \d+ more findings are not in this list\./)
    expect(text.endsWith("Change nothing until I say so.")).toBe(true)
  })

  test("it is written in Korean for a Korean user", () => {
    const text = checkMessage(ko, { missingLinks: [], unlinked: ["C"], noSource: [] })
    expect(text.startsWith("지식을 점검해 주세요.")).toBe(true)
    expect(text).toContain("- C을(를) 링크하는 다른 글이 없습니다.")
  })
})
