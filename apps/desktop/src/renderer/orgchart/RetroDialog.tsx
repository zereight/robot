import type { RetroProposal } from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import styles from "../orgs/orgs.module.css"
import { openSkillProposal } from "../skills/SkillForm.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { setProfileTarget } from "../state/profileTarget.ts"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"

// The proposals of a retrospective (spec 030, "Retrospective"). A look back gives one to three
// proposals. Each one opens the form of its kind, filled in, and the user saves it or closes it:
// nothing is saved here.

/** What the user does with a proposal: open the form of its kind. */
const apply = (proposal: RetroProposal, agentId: string | undefined) => {
  if (proposal.kind === "skill") {
    openSkillProposal(
      {
        name: proposal.name,
        description: proposal.description,
        instructions: proposal.instructions,
      },
      agentId,
    )
    return
  }
  // Instructions: the profile of the agent, with the text in the field of its instructions. The
  // profile owns the save, so the retrospective never writes to an agent itself.
  setProfileTarget(agentId)
}

export const RetroDialog = (props: { orgId: string; orgName: string; onClose: () => void }) => {
  const { t } = useApp()
  const agents = useAgents()
  const [phase, setPhase] = createSignal<"writing" | "ready" | "failed" | "empty">("writing")
  const [proposals, setProposals] = createSignal<readonly RetroProposal[]>([])
  const [failure, setFailure] = createSignal<ErrorText>()
  let requestId = ""
  let closed = false

  const write = async () => {
    const mine = crypto.randomUUID()
    requestId = mine
    setPhase("writing")
    setFailure(undefined)
    try {
      const out = await call("retro.look", { orgId: props.orgId, requestId: mine })
      if (closed || requestId !== mine) return
      setProposals(out)
      setPhase(out.length > 0 ? "ready" : "empty")
    } catch (e) {
      if (closed || requestId !== mine) return
      setFailure(describeError(e))
      setPhase("failed")
    }
  }
  void write()

  const close = () => {
    // A look back that runs is dropped: the answer is not used, and nothing was saved anyway.
    if (phase() === "writing" && requestId) void call("retro.cancel", { requestId })
    closed = true
    props.onClose()
  }

  /** The agent that a proposal names, by name. The user picks the rest in the form. */
  const agentOf = (name: string) => agents.agents().find((a) => a.name === name)

  return (
    <Dialog
      label={t("retro.title", { organization: props.orgName })}
      onClose={close}
      testId="retro-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("retro.title", { organization: props.orgName })}</h2>
        <Show when={phase() === "writing"}>
          <p class={styles.hint} role="status" data-testid="retro-writing">
            {t("retro.writing")}
          </p>
        </Show>
        <Show when={phase() === "failed"}>
          <div class={styles.error} role="alert" data-testid="retro-failed">
            {failure()?.key ? t(failure()?.key as never) : ""}
          </div>
        </Show>
        <Show when={phase() === "empty"}>
          <p class={styles.hint} data-testid="retro-empty">
            {t("error.retro_empty")}
          </p>
        </Show>
        <Show when={phase() === "ready"}>
          <p class={styles.hint}>{t("retro.hint")}</p>
          <ol class={styles.list}>
            <For each={proposals()}>
              {(proposal) => (
                <li class={styles.row} data-testid="retro-proposal" data-kind={proposal.kind}>
                  <div class={styles.proposalHead}>
                    <span class={styles.proposalName}>
                      {proposal.kind === "skill" ? proposal.name : t("retro.kind.instructions")}
                    </span>
                    <span class={styles.hint}>{proposal.agent}</span>
                  </div>
                  <Show when={proposal.evidence !== ""}>
                    <span class={styles.hint} data-testid="retro-evidence">
                      {proposal.evidence}
                    </span>
                  </Show>
                  <Button
                    onClick={() => {
                      apply(proposal, agentOf(proposal.agent)?.id)
                      close()
                    }}
                    data-testid="retro-take"
                  >
                    {proposal.kind === "skill" ? t("retro.openSkill") : t("retro.openProfile")}
                  </Button>
                </li>
              )}
            </For>
          </ol>
        </Show>
        <div class={styles.actions}>
          <span class={styles.spacer} />
          <Button onClick={close} data-testid="retro-close">
            {t("agents.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
