import { type MessageKey, translate } from "./i18n/index.ts"
import type { Locale } from "./settings.ts"
import type { TlaStarterText, WorkflowStarterId } from "./workflowStarters.ts"

// The text of the workflow starters. Only the window and the tests read this file: the window
// picks the language when the user presses Create, and the app gets a finished workflow.

/**
 * The text of a starter in one language (spec 010, "Starters"). The lines `TLC_RESULT:` and
 * `Blocked:` are in the prompts as they are, in every language, because the app reads them.
 */
export const workflowStarterText = (locale: Locale, id: WorkflowStarterId): TlaStarterText => {
  const text = (part: string) => translate(locale, `workflowStarter.${id}.${part}` as MessageKey)
  return {
    name: text("name"),
    job: text("job"),
    needs: text("needs"),
    write: { name: text("write.name"), prompt: text("write.prompt") },
    run: { name: text("run.name"), prompt: text("run.prompt") },
    check: { name: text("check.name") },
    pass: { name: text("pass.name"), title: text("pass.title") },
    explain: { name: text("explain.name"), prompt: text("explain.prompt") },
    gap: { name: text("gap.name"), title: text("gap.title") },
    note: text("note"),
  }
}
