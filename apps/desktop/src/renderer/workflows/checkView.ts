import {
  type CheckOutcome,
  type CheckProblem,
  type CheckStep,
  problemNodeIds,
  problemPath,
} from "@robot/shared"

/** The problems of a result: none unless the check found a problem. */
export const problemsOf = (outcome: CheckOutcome | null): readonly CheckProblem[] =>
  outcome?.state === "problem" ? outcome.problems : []

/**
 * What the canvas marks (spec 010, "Problem found"): each node of the path of the first problem
 * with the number of its line, and the nodes of the problems.
 */
export const marksOf = (outcome: CheckOutcome | null) => {
  const problems = problemsOf(outcome)
  const lines = new Map<string, number>()
  const path: readonly CheckStep[] = problems[0] ? problemPath(problems[0]) : []
  path.forEach((step, i) => {
    lines.set(step.nodeId, i + 1)
  })
  const faults = new Set(problems.flatMap((p) => problemNodeIds(p)))
  return { lines, faults }
}
