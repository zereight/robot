import { Schema } from "effect"
import { AGENT_NAME_MAX, AGENT_ROLE_MAX, charLength } from "./agents.ts"
import { CHANNEL_NAME_MAX, CHANNEL_TOPIC_MAX } from "./channels.ts"

// The matching of the goal dialog and the checks of a saved starter (spec 031). This file holds no
// interface text and calls no model: the app picks only from a fixed list.

/** All starters of the goal dialog, in the order of the list ("Matching" in spec 031). */
export const GOAL_STARTERS = [
  "assistant",
  "briefer",
  "researcher",
  "reviewer",
  "organizer",
  "research",
  "codeReview",
  "files",
  "product",
] as const
export type GoalStarterId = (typeof GOAL_STARTERS)[number]

export const GOAL_TEXT_MAX = 300
export const RECOMMENDED_MAX = 3

/** English keywords start a word. Korean keywords are a part of a text. */
const KEYWORDS: Readonly<Record<GoalStarterId, { en: readonly string[]; ko: readonly string[] }>> =
  {
    assistant: {
      en: ["question", "answer", "writ", "draft", "email", "explain"],
      ko: ["질문", "답변", "답장", "글쓰기", "작성", "메일", "설명"],
    },
    briefer: {
      en: ["briefing", "news", "digest", "summar", "daily"],
      ko: ["브리핑", "뉴스", "요약", "소식", "매일"],
    },
    researcher: {
      en: ["research", "fact", "source", "verif", "compar", "study"],
      ko: ["조사", "리서치", "사실", "출처", "검증", "비교"],
    },
    reviewer: {
      en: ["review", "code", "bug", "diff", "test"],
      ko: ["리뷰", "코드", "버그", "풀 리퀘스트", "테스트"],
    },
    organizer: {
      en: ["file", "folder", "organi", "sort", "renam", "tidy"],
      ko: ["파일", "폴더", "정리", "분류", "이름 바", "정돈"],
    },
    research: {
      en: ["investigat", "report", "survey", "literat"],
      ko: ["보고서", "연구", "자료"],
    },
    codeReview: {
      en: ["review", "diff", "commit"],
      ko: ["리뷰", "풀 리퀘스트", "변경 검토"],
    },
    files: {
      en: ["desktop", "download", "folder", "tidy"],
      ko: ["바탕화면", "다운로드", "폴더", "정리"],
    },
    product: {
      en: ["product", "feature", "sprint", "ship", "release", "roadmap", "design"],
      ko: ["제품", "기획", "개발", "기능", "출시", "스프린트", "디자인"],
    },
  }

/** The goal text holds up to 300 characters; a paste over the limit is cut. */
export const clipGoal = (text: string) => [...text].slice(0, GOAL_TEXT_MAX).join("")

const startsAWord = (text: string, keyword: string) => {
  let from = text.indexOf(keyword)
  while (from !== -1) {
    if (from === 0 || !/[\p{L}\p{N}]/u.test(text[from - 1] ?? "")) return true
    from = text.indexOf(keyword, from + 1)
  }
  return false
}

export interface GoalMatch {
  readonly id: GoalStarterId
  readonly score: number
}

/**
 * The starters that fit the goal text, best fit first, at most three. A keyword counts once. The
 * keywords of both languages match in both interface languages. Equal scores keep the list order.
 */
export const recommend = (goal: string): readonly GoalMatch[] => {
  const text = goal.trim().toLowerCase()
  if (text === "") return []
  return GOAL_STARTERS.map((id) => {
    const { en, ko } = KEYWORDS[id]
    const score =
      en.filter((k) => startsAWord(text, k)).length + ko.filter((k) => text.includes(k)).length
    return { id, score }
  })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, RECOMMENDED_MAX)
}

export const SAVED_STARTER_MAX = 20
export const SAVED_AGENTS_MIN = 2
export const SAVED_AGENTS_MAX = 9

export const SavedStarterAgent = Schema.Struct({
  name: Schema.String,
  role: Schema.String,
  instructions: Schema.String,
})
export type SavedStarterAgent = typeof SavedStarterAgent.Type

/** A channel starter that the user made (spec 031, "Saved starters"). `lead` indexes `agents`. */
export const SavedStarterDraft = Schema.Struct({
  name: Schema.String,
  topic: Schema.String,
  lead: Schema.Number,
  agents: Schema.Array(SavedStarterAgent),
})
export type SavedStarterDraft = typeof SavedStarterDraft.Type

export const SavedStarter = Schema.Struct({ id: Schema.String, ...SavedStarterDraft.fields })
export type SavedStarter = typeof SavedStarter.Type

export type SavedStarterProblem = "name" | "topic" | "agents" | "lead" | "agentName" | "agentRole"

/** The reasons "Save" is off. An empty list means the starter can be saved. */
export const savedStarterProblems = (s: SavedStarterDraft): SavedStarterProblem[] => {
  const problems = new Set<SavedStarterProblem>()
  const name = s.name.trim()
  if (name === "" || charLength(name) > CHANNEL_NAME_MAX) problems.add("name")
  if (charLength(s.topic) > CHANNEL_TOPIC_MAX) problems.add("topic")
  if (s.agents.length < SAVED_AGENTS_MIN || s.agents.length > SAVED_AGENTS_MAX)
    problems.add("agents")
  if (!Number.isInteger(s.lead) || s.lead < 0 || s.lead >= s.agents.length) problems.add("lead")
  for (const a of s.agents) {
    const n = a.name.trim()
    if (n === "" || charLength(n) > AGENT_NAME_MAX) problems.add("agentName")
    if (charLength(a.role) > AGENT_ROLE_MAX) problems.add("agentRole")
  }
  return [...problems]
}
