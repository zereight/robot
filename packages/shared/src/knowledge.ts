import { charLength } from "./agents.ts"
import type { MessageKey, MessageParams } from "./i18n/index.ts"

/** Name of the folder in the agent workspace, and of the folder for sources inside it. */
export const KNOWLEDGE_FOLDER = "Knowledge"
export const KNOWLEDGE_SOURCES = "sources"

export const KNOWLEDGE_TITLE_MAX = 80
export const KNOWLEDGE_SUMMARY_MAX = 160
export const KNOWLEDGE_BODY_MAX = 20_000
export const KNOWLEDGE_ARTICLES_MAX = 500
export const KNOWLEDGE_CHANGES_MAX = 50
export const KNOWLEDGE_TURN_CHANGES_MAX = 5
export const KNOWLEDGE_LINES_MAX = 100
export const KNOWLEDGE_CHARS_MAX = 6000
export const KNOWLEDGE_SOURCE_BYTES = 20 * 1024 * 1024

/** The person who made a change. */
export type KnowledgeActor = "agent" | "user"
export type KnowledgeChangeKind = "add" | "edit" | "delete"

/** One line of the article list. */
export interface KnowledgeSummary {
  /** The file name in the Knowledge folder. It names the article for the window. */
  readonly file: string
  readonly title: string
  readonly summary: string
  /** When the file changed last. */
  readonly updatedAt: number
  /** Who edited it last. */
  readonly editor: KnowledgeActor
}

export interface KnowledgeLink {
  readonly title: string
  /** The file of the linked article. Null when no such article exists. */
  readonly file: string | null
}

export interface KnowledgeSourceRef {
  readonly name: string
  /** False when the source file was deleted. */
  readonly exists: boolean
}

export interface KnowledgeArticle extends KnowledgeSummary {
  readonly body: string
  readonly links: readonly KnowledgeLink[]
  readonly sources: readonly KnowledgeSourceRef[]
}

export interface KnowledgeSource {
  readonly name: string
  readonly size: number
  readonly addedAt: number
}

/** What the Knowledge page shows for one agent. */
export interface KnowledgeView {
  readonly enabled: boolean
  /** Full path of the Knowledge folder. */
  readonly folder: string
  /** False until the first article is saved: the folder may exist for a source before that. */
  readonly canOpenFolder: boolean
  /** The articles that match the search, by title. */
  readonly articles: readonly KnowledgeSummary[]
  /** All articles of the agent, whatever the search. */
  readonly total: number
  readonly limit: number
  readonly sources: readonly KnowledgeSource[]
  /** Files in the folder that are not shown: a second article with a title that is taken. */
  readonly skipped: number
}

export interface KnowledgeChange {
  readonly id: string
  readonly kind: KnowledgeChangeKind
  readonly title: string
  readonly actor: KnowledgeActor
  readonly at: number
  /** The file text before the change. Null for an added article. */
  readonly before: string | null
  readonly undone: boolean
}

/** What a report of the check shows. */
export interface KnowledgeFindings {
  readonly missingLinks: readonly { readonly from: string; readonly to: string }[]
  readonly unlinked: readonly string[]
  readonly noSource: readonly string[]
}

/** What a knowledge tool did, kept with its card in the chat. */
export type KnowledgeNote =
  | { readonly kind: "read"; readonly title: string }
  | {
      readonly kind: "write"
      readonly title: string
      readonly change: KnowledgeChangeKind
      readonly changeId: string
    }
  | { readonly kind: "source"; readonly name: string }
  | { readonly kind: "failed"; readonly title: string; readonly code: string }

/** The error codes of the knowledge tools. Each has a message in every language. */
export const KNOWLEDGE_ERRORS = [
  "knowledge_title_invalid",
  "knowledge_summary_long",
  "knowledge_body_long",
  "knowledge_title_taken",
  "knowledge_full",
  "knowledge_secret",
  "knowledge_not_found",
  "knowledge_turn_limit",
  "knowledge_source_missing",
  "knowledge_source_invalid",
  "knowledge_source_big",
  "knowledge_changed",
  "knowledge_off",
  "knowledge_denied",
  "knowledge_undone",
  "knowledge_fetch_failed",
  "knowledge_io",
] as const

/** Turns control characters into spaces. */
const noControl = (text: string) =>
  [...text].map((ch) => ((ch.codePointAt(0) ?? 32) < 32 ? " " : ch)).join("")

/** Cuts line breaks and runs of spaces down to single spaces. */
export const cleanLine = (text: string) => text.replace(/\s+/g, " ").trim()

/** The key that makes titles unique for one agent: clean, NFC, ignoring case. */
export const titleKey = (title: string) => cleanLine(title).normalize("NFC").toLocaleLowerCase()

/** The first limit that a text breaks, as an error code, or null. */
export const articleLimit = (title: string, summary: string, body: string) => {
  const t = charLength(cleanLine(title))
  if (t < 1 || t > KNOWLEDGE_TITLE_MAX) return "knowledge_title_invalid"
  if (charLength(summary) > KNOWLEDGE_SUMMARY_MAX) return "knowledge_summary_long"
  if (charLength(body) > KNOWLEDGE_BODY_MAX) return "knowledge_body_long"
  return null
}

/** The parts of an article file. */
export interface ArticleFile {
  readonly title: string
  readonly summary: string
  readonly body: string
  /** File names in the sources folder. */
  readonly sources: readonly string[]
  /** Other header lines of the file. The app keeps them as they are. */
  readonly extra: readonly string[]
}

const stem = (fileName: string) => fileName.replace(/\.md$/i, "")

/**
 * Reads an article file. A file starts with a header between two `---` lines (title, summary,
 * and one `source:` line for each source). A file with no header is still an article: its
 * title is its file name and its summary is its first line of text.
 */
export const parseArticleFile = (fileName: string, raw: string): ArticleFile => {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  const lines = text.split("\n")
  let title = ""
  let summary = ""
  const sources: string[] = []
  const extra: string[] = []
  let body = text
  let named = false
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---")
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line)
        const key = match?.[1]?.toLowerCase()
        const value = match?.[2] ?? ""
        if (key === "title") {
          title = cleanLine(value)
          named = true
        } else if (key === "summary") {
          summary = cleanLine(value)
          named = true
        } else if (key === "source") {
          const name = value.trim()
          if (name && !sources.includes(name)) sources.push(name)
        } else if (line.trim() !== "") extra.push(line)
      }
      body = lines
        .slice(end + 1)
        .join("\n")
        .replace(/^\n+/, "")
    }
  }
  body = body.replace(/^\n+/, "").trimEnd()
  // No title and no summary: the summary is the first line of the text, as it is.
  if (!named) {
    const first = body.split("\n").find((line) => line.trim() !== "")
    summary = first ? cleanLine(first).slice(0, KNOWLEDGE_SUMMARY_MAX) : ""
  }
  return { title: title || cleanLine(stem(fileName)), summary, body, sources, extra }
}

/** The text of an article file. */
export const formatArticleFile = (article: ArticleFile) =>
  [
    "---",
    `title: ${article.title}`,
    `summary: ${article.summary}`,
    ...article.sources.map((name) => `source: ${name}`),
    ...article.extra,
    "---",
    "",
    article.body,
    "",
  ].join("\n")

/** The titles that a body links to, written as [[Title]]. Each title once. */
export const articleLinks = (body: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of body.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
    const title = cleanLine(match[1] ?? "")
    const key = titleKey(title)
    if (key && !seen.has(key)) {
      seen.add(key)
      out.push(title)
    }
  }
  return out
}

/** Adds the links that the body does not name yet to its end. */
export const withLinks = (body: string, links: readonly string[]) => {
  const named = new Set(articleLinks(body).map(titleKey))
  const extra: string[] = []
  for (const link of links) {
    const title = cleanLine(link)
    const key = titleKey(title)
    if (key && !named.has(key)) {
      named.add(key)
      extra.push(`[[${title}]]`)
    }
  }
  return extra.length === 0 ? body : `${body}${body ? "\n\n" : ""}See also: ${extra.join(", ")}`
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A file name for an article, made from its title. A name that is taken gets a number. The
 * check `taken` gets the name with its extension.
 */
export const articleFileName = (title: string, taken: (name: string) => boolean) => {
  let base = cleanLine(noControl(title).replace(/[\\/:*?"<>|]/g, " "))
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, KNOWLEDGE_TITLE_MAX)
    .trim()
  if (!base) base = "article"
  if (RESERVED.test(base)) base = `${base}_`
  let name = `${base}.md`
  for (let n = 2; taken(name); n++) name = `${base} (${n}).md`
  return name
}

/** A name for a source file. It has no path. */
export const sourceFileName = (name: string, taken: (name: string) => boolean) => {
  const last = name.replace(/\\/g, "/").split("/").pop() ?? ""
  let clean = cleanLine(noControl(last).replace(/[:*?"<>|]/g, " "))
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim()
  if (!clean) clean = "source"
  if (RESERVED.test(clean.replace(/\.[^.]*$/, ""))) clean = `_${clean}`
  const dot = clean.lastIndexOf(".")
  const base = dot > 0 ? clean.slice(0, dot) : clean
  const ext = dot > 0 ? clean.slice(dot) : ""
  let out = clean
  for (let n = 2; taken(out); n++) out = `${base} (${n})${ext}`
  return out
}

const words = (text: string) =>
  new Set(
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => [...w].length >= 2),
  )

export interface ContentsEntry {
  readonly title: string
  readonly summary: string
  readonly updatedAt: number
}

/** One line of the contents list. A summary that a valid article cannot have is cut. */
export const contentsLine = (entry: ContentsEntry) => {
  const summary = [...entry.summary].slice(0, KNOWLEDGE_SUMMARY_MAX).join("")
  return summary ? `- ${entry.title}: ${summary}` : `- ${entry.title}`
}

/**
 * The contents list for one turn: a line for each article, at most 100 lines and 6,000
 * characters. A list that fits is given whole, by title. If it does not fit, the lines that
 * share words with the message come first, then the newest. A line that does not fit is left
 * out. After a list that is cut, one line says how many articles are not in it: `note` writes
 * it, and it counts in the 100 lines and the 6,000 characters.
 */
export const contentsList = (
  entries: readonly ContentsEntry[],
  message: string,
  note: (omitted: number) => string = (omitted) =>
    `(${omitted} more articles are not in this list.)`,
) => {
  const size = (lines: readonly string[]) => lines.reduce((sum, line) => sum + line.length + 1, 0)
  const all = [...entries].sort((a, b) => a.title.localeCompare(b.title)).map(contentsLine)
  if (all.length <= KNOWLEDGE_LINES_MAX && size(all) <= KNOWLEDGE_CHARS_MAX)
    return { lines: all, omitted: 0, note: null as string | null }
  const wanted = words(message)
  const scored = entries
    .map((entry) => {
      let score = 0
      // A word also matches when one is the start of the other: Korean particles follow nouns.
      for (const w of words(`${entry.title} ${entry.summary}`))
        if ([...wanted].some((q) => q === w || q.startsWith(w) || w.startsWith(q))) score++
      return { entry, score }
    })
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
  // The line that says how many articles are left out is the longest when all are left out.
  const room = KNOWLEDGE_CHARS_MAX - (note(entries.length).length + 1)
  const lines: string[] = []
  let chars = 0
  for (const { entry } of scored) {
    if (lines.length >= KNOWLEDGE_LINES_MAX - 1) break
    const line = contentsLine(entry)
    if (chars + line.length + 1 > room) continue
    lines.push(line)
    chars += line.length + 1
  }
  const omitted = entries.length - lines.length
  return { lines, omitted, note: note(omitted) as string | null }
}

export interface FindingsInput {
  readonly title: string
  readonly body: string
  /** The sources of the article that exist. */
  readonly sources: readonly string[]
}

/** The problems that the app can see without a model: broken links, loose articles, no source. */
export const knowledgeFindings = (articles: readonly FindingsInput[]): KnowledgeFindings => {
  const keys = new Set(articles.map((a) => titleKey(a.title)))
  const linkedFrom = new Map<string, Set<string>>()
  const missingLinks: { from: string; to: string }[] = []
  for (const article of articles) {
    const own = titleKey(article.title)
    for (const link of articleLinks(article.body)) {
      const key = titleKey(link)
      if (!keys.has(key)) missingLinks.push({ from: article.title, to: link })
      else if (key !== own) linkedFrom.set(key, (linkedFrom.get(key) ?? new Set()).add(own))
    }
  }
  return {
    missingLinks,
    unlinked:
      articles.length < 2
        ? []
        : articles.filter((a) => !linkedFrom.has(titleKey(a.title))).map((a) => a.title),
    noSource: articles.filter((a) => a.sources.length === 0).map((a) => a.title),
  }
}

/** The most characters of the message that "Check knowledge" sends. A chat message has a limit. */
const CHECK_CHARS_MAX = 90_000

/**
 * The message that "Check knowledge" sends in the chat, as the user: what the app found, then
 * the request to read all articles and to add statements that disagree. Every finding is in it.
 * Only a message that would be too long for a chat message ends with a line that counts the rest.
 */
export const checkMessage = (
  t: (key: MessageKey, params?: MessageParams) => string,
  found: KnowledgeFindings,
) => {
  const lines = [
    ...found.missingLinks.map((l) => t("knowledge.check.missing", { from: l.from, to: l.to })),
    ...found.unlinked.map((title) => t("knowledge.check.unlinked", { title })),
    ...found.noSource.map((title) => t("knowledge.check.noSource", { title })),
  ]
  const kept: string[] = []
  let chars = 0
  for (const line of lines) {
    if (chars + line.length + 4 > CHECK_CHARS_MAX) break
    kept.push(line)
    chars += line.length + 3
  }
  const rest = lines.length - kept.length
  const report =
    lines.length === 0
      ? t("knowledge.check.clean")
      : [
          t("knowledge.check.found"),
          ...kept.map((line) => `- ${line}`),
          ...(rest > 0 ? [`- ${t("knowledge.check.more", { count: rest })}`] : []),
        ].join("\n")
  return [t("knowledge.check.message"), report, t("knowledge.check.request")].join("\n\n")
}
