/** The key of the line of a pass on a question card (spec 004, 030). */
export const passKey = (kind: "user_choice" | "not_sure" | "late" | "failure", reason: string) =>
  kind === "late"
    ? ("tool.leadPass.late" as const)
    : kind === "failure"
      ? ("tool.leadPass.failure" as const)
      : reason !== ""
        ? ("tool.leadPass.reason" as const)
        : kind === "user_choice"
          ? ("tool.leadPass.user_choice" as const)
          : ("tool.leadPass.not_sure" as const)
