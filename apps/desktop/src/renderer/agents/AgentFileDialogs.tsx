import {
  AGENT_FILE_MAX_AGENTS,
  AGENT_FILE_MAX_SKILLS,
  type AgentFileFailure,
  type AgentFilePreview,
  type AgentModel,
  agentCounts,
  agentPicks,
  handbookPreview,
  type MessageKey,
  type NotImported,
  planTeam,
  type Skill,
  skillsForFile,
  skippedNotImported,
  startAgentTicks,
  startTeamTicks,
  tickedPlaces,
} from "@robot/shared"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import review from "../imports/imports.module.css"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { useScheduleWords } from "../routines/RoutinesPage.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./agents.module.css"
import { Face } from "./Face.tsx"

/** Choose agents, then save them in one file. */
export const ExportAgentsDialog = (props: { onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(
    new Set(agents.agents().map((a) => a.id)),
  )
  const [skills] = createResource(
    () => ui.server()?.id,
    (serverId) => call("skills.list", { serverId }).catch(() => [] as readonly Skill[]),
    { initialValue: [] as readonly Skill[] },
  )
  const [handbook] = createResource(
    () => ui.server()?.id,
    (serverId) => call("handbook.get", { serverId }).catch(() => undefined),
  )
  // The two tick boxes are off at the start (spec 002).
  const [withSkills, setWithSkills] = createSignal(false)
  const [withHandbook, setWithHandbook] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  const [saved, setSaved] = createSignal<{
    path: string
    count: number
    skills: number
    handbook: boolean
    team: boolean
  }>()

  const allPicked = () => agents.agents().length > 0 && picked().size === agents.agents().length
  const tooMany = () => picked().size > AGENT_FILE_MAX_AGENTS
  /** The skills that the file would hold for the agents that are picked now. */
  const skillCount = () => skillsForFile(skills(), picked()).length
  const tooManySkills = () => withSkills() && skillCount() > AGENT_FILE_MAX_SKILLS
  const handbookEmpty = () => (handbook()?.text ?? "").trim() === ""
  const toggle = (id: string) => {
    const next = new Set(picked())
    if (!next.delete(id)) next.add(id)
    setPicked(next)
  }

  const submit = async () => {
    const serverId = ui.server()?.id
    if (!serverId || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await call("agentFile.export", {
        serverId,
        agentIds: [...picked()],
        channels: false,
        skills: withSkills(),
        handbook: withHandbook(),
      })
      if (result.path)
        setSaved({
          path: result.path,
          count: result.count,
          skills: result.skills,
          handbook: result.handbook,
          team: withSkills(),
        })
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={t("agentFile.export.title")}
      onClose={props.onClose}
      testId="agent-export-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("agentFile.export.title")}</h2>
        <p class={styles.hint}>{t("agentFile.export.hint")}</p>
        <Show
          when={agents.agents().length > 0}
          fallback={<p class={styles.hint}>{t("agentFile.export.empty")}</p>}
        >
          <label class={styles.fileRow}>
            <input
              type="checkbox"
              checked={allPicked()}
              onChange={() =>
                setPicked(allPicked() ? new Set() : new Set(agents.agents().map((a) => a.id)))
              }
              data-testid="agent-export-all"
            />
            <span class={styles.label}>{t("agentFile.export.all")}</span>
          </label>
          <ul class={styles.fileList}>
            <For each={agents.agents()}>
              {(agent) => (
                <li>
                  <label class={styles.fileRow}>
                    <input
                      type="checkbox"
                      checked={picked().has(agent.id)}
                      onChange={() => toggle(agent.id)}
                      data-testid="agent-export-item"
                    />
                    <Face face={agent.face} image={agent.faceImage} size={28} />
                    <span class={styles.fileText}>
                      <span class={styles.label}>{agent.name}</span>
                      <Show when={agent.role}>
                        <span class={styles.hint}>{agent.role}</span>
                      </Show>
                    </span>
                  </label>
                </li>
              )}
            </For>
          </ul>
          <fieldset class={styles.group} data-testid="agent-export-team">
            <legend class={styles.label}>{t("agentFile.export.team.title")}</legend>
            <div class={review.teamTicks}>
              <label class={review.tickRow}>
                <input
                  type="checkbox"
                  checked={withSkills()}
                  onChange={(e) => setWithSkills(e.currentTarget.checked)}
                  data-testid="agent-export-skills"
                />
                <span class={review.rowText}>
                  <span class={styles.label}>
                    {t("agentFile.export.team.skills")}{" "}
                    <span class={styles.hint} data-testid="agent-export-skills-count">
                      {t("agentFile.export.team.found", { count: skillCount() })}
                    </span>
                  </span>
                  <span class={styles.hint}>{t("agentFile.export.team.skills.hint")}</span>
                </span>
              </label>
              <label class={review.tickRow}>
                <input
                  type="checkbox"
                  checked={withHandbook() && !handbookEmpty()}
                  disabled={handbookEmpty()}
                  onChange={(e) => setWithHandbook(e.currentTarget.checked)}
                  data-testid="agent-export-handbook"
                />
                <span class={review.rowText}>
                  <span class={styles.label}>{t("agentFile.export.team.handbook")}</span>
                  <span class={styles.hint}>
                    {handbookEmpty()
                      ? t("agentFile.export.team.handbook.empty")
                      : t("agentFile.export.team.handbook.hint")}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
        </Show>
        <Show when={tooMany()}>
          <div class={styles.error} role="alert">
            {t("agentFile.export.limit")}
          </div>
        </Show>
        <Show when={tooManySkills()}>
          <div class={styles.error} role="alert" data-testid="agent-export-limit-skills">
            {t("agentFile.export.limit.skills")}
          </div>
        </Show>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="agent-export-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <Show when={saved()}>
          {(done) => (
            <p role="status" data-testid="agent-export-saved">
              {done().team
                ? t("agentFile.exported.team", {
                    count: done().count,
                    skills: done().skills,
                    path: done().path,
                  })
                : t("agentFile.exported", { count: done().count, path: done().path })}
              <Show when={done().handbook}>
                <br />
                {t("agentFile.exported.handbook")}
              </Show>
            </p>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="agent-export-close">
            {saved() ? t("agentFile.close") : t("agents.cancel")}
          </Button>
          <Show when={!saved()}>
            <Button
              variant="primary"
              disabled={picked().size === 0 || tooMany() || tooManySkills() || busy()}
              onClick={submit}
              data-testid="agent-export-submit"
            >
              {t("agentFile.export.submit")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

/** The failure of an import that made some agents, read from its error detail. */
const readFailure = (error: unknown): AgentFileFailure | undefined => {
  if (!(error instanceof RpcFailure) || error.error.code !== "agent_file_failed") return undefined
  try {
    return JSON.parse(error.error.message) as AgentFileFailure
  } catch {
    return undefined
  }
}

/** One line of the part "Not imported": where it is in the file, and why it is not made. */
export const NotImportedList = (props: {
  items: readonly NotImported[]
  /** The channels of a file of an older version. ROBot has no channels now (spec 002). */
  channels?: readonly string[]
  testId: string
}) => {
  const { t } = useApp()
  const where = (item: NotImported): string => {
    switch (item.reason) {
      case "no_place":
        return t("importReview.notImported.step", {
          owner: item.owner,
          step: item.step,
          name: item.name,
        })
      case "channel_no_member":
        return t("importReview.notImported.channel", { owner: item.owner })
      case "skill_no_agent":
      case "skills_full":
        return t("importReview.notImported.skill", { owner: item.owner })
      case "no_step":
        return t("importReview.notImported.node", {
          owner: item.owner,
          type: item.nodeType,
          name: item.name,
        })
      case "text_cut":
        return t("importReview.notImported.cut", { owner: item.owner, name: item.name })
      case "unknown_field":
        return item.owner === null
          ? t("importReview.notImported.file", { field: item.field })
          : t("importReview.notImported.field", { owner: item.owner, field: item.field })
    }
  }
  return (
    <div data-testid={props.testId}>
      <h3 class={review.sectionTitle}>{t("importReview.notImported.title")}</h3>
      <Show
        when={props.items.length > 0 || (props.channels?.length ?? 0) > 0}
        fallback={<p class={review.hint}>{t("importReview.notImported.empty")}</p>}
      >
        <ul class={review.notImported}>
          <For each={props.channels ?? []}>
            {(name) => (
              <li data-testid="not-imported-item">
                <span>{t("importReview.notImported.channel", { owner: name })}</span>{" "}
                <span class={review.hint}>{t("importReview.reason.channel_gone")}</span>
              </li>
            )}
          </For>
          <For each={props.items}>
            {(item) => (
              <li data-testid="not-imported-item">
                <span>{where(item)}</span>{" "}
                <span class={review.hint}>{t(`importReview.reason.${item.reason}` as const)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

/** The mark of a part where the app hid a secret. */
export const SecretMark = () => {
  const { t } = useApp()
  return (
    <span class={review.secret} data-testid="import-secret">
      {t("importReview.secret")}
    </span>
  )
}

/**
 * The review before an import (spec 014): each agent with its instructions and routines, each
 * with a tick box, the part "Not imported", the counts, one model for all, and the import button.
 */
export const ImportAgentsDialog = (props: { preview: AgentFilePreview; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const words = useScheduleWords()
  const [model, setModel] = createSignal<AgentModel | null>(null)
  const [ticks, setTicks] = createStore<
    { agent: boolean; instructions: boolean; routines: boolean[] }[]
  >(startAgentTicks(props.preview.agents).map((a) => ({ ...a, routines: [...a.routines] })))
  // Skills start ticked; the handbook does not (spec 014). Channels are not imported (spec 002).
  const [team, setTeam] = createStore(
    (() => {
      const start = startTeamTicks(props.preview)
      return { skills: [...start.skills], handbook: start.handbook }
    })(),
  )
  const [showAll, setShowAll] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  /** Set when the import stopped: the agents made so far stay, so it cannot run again. */
  const [stopped, setStopped] = createSignal(false)
  const hasTeam = () => props.preview.skills.length > 0 || props.preview.handbook !== null
  /** What the ticks make of the skills: a skill may lose its agents (spec 002). */
  const plan = createMemo(() =>
    planTeam({
      channels: [],
      skills: props.preview.skills,
      made: (agent) => ticks[agent]?.agent === true,
      channelPicks: [],
      skillPicks: tickedPlaces(team.skills),
      skillRoom: props.preview.skillRoom,
    }),
  )
  const counts = () => ({
    ...agentCounts(ticks),
    skills: plan().skills.length,
    handbook: team.handbook && props.preview.handbook !== null,
  })
  /** The numbers of the counts line, for the text. */
  const countWords = () => {
    const { agents, routines, skills } = counts()
    return { agents, routines, skills }
  }
  const nothing = () => counts().agents === 0 && !counts().handbook
  const notImported = () => [
    ...props.preview.notImported,
    ...skippedNotImported(plan().skipped, props.preview),
  ]
  const names = (places: readonly number[]) =>
    places.map((i) => props.preview.agents[i]?.name ?? "").join(", ")
  const handbookText = () => {
    const text = props.preview.handbook?.text ?? ""
    const first = handbookPreview(text)
    return { shown: showAll() ? text : first.text, more: first.more }
  }

  const submit = async () => {
    const serverId = ui.server()?.id
    if (!serverId || busy() || stopped() || nothing()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await call("agentFile.apply", {
        serverId,
        model: model(),
        pick: agentPicks(ticks),
        channels: [],
        skills: tickedPlaces(team.skills),
        handbook: counts().handbook,
      })
      // The dialog closes. A line tells what was made, and the new things show in their lists.
      showToast("success", result.skills > 0 ? "agentFile.imported.team" : "agentFile.imported", {
        agents: result.agents,
        routines: result.routines,
        skills: result.skills,
      })
      if (result.handbook) showToast("success", "agentFile.imported.handbook")
      props.onClose()
    } catch (e) {
      const failure = readFailure(e)
      if (failure) {
        const reason = describeError(
          new RpcFailure({ code: failure.code, message: failure.detail ?? failure.code }),
        )
        const key: MessageKey =
          failure.kind === "skill"
            ? "agentFile.import.stopped.skill"
            : failure.kind === "handbook"
              ? "agentFile.import.stopped.handbook"
              : "agentFile.import.stopped"
        setError({
          key,
          params: {
            name: failure.name,
            made: failure.made,
            skills: failure.madeSkills ?? 0,
            reason: t(reason.key, reason.params),
          },
        })
        setStopped(true)
      } else {
        setError(describeError(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={t("agentFile.import.title")}
      onClose={props.onClose}
      testId="agent-import-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("agentFile.import.title")}</h2>
        <p class={styles.hint}>{t("importReview.agents.intro")}</p>
        <ul class={review.review} data-testid="agent-import-list">
          <For each={props.preview.agents}>
            {(item, i) => (
              <li
                class={review.reviewItem}
                data-testid="agent-import-item"
                data-ticked={ticks[i()]?.agent}
              >
                <label class={review.row}>
                  <input
                    type="checkbox"
                    checked={ticks[i()]?.agent}
                    onChange={(e) => setTicks(i(), "agent", e.currentTarget.checked)}
                    data-testid="agent-import-tick"
                  />
                  <Face face={item.face} size={28} />
                  <span class={review.rowText}>
                    <span class={styles.label}>{item.name}</span>
                    <Show when={item.fileName}>
                      {(original) => (
                        <span class={styles.hint}>
                          {t("agentFile.import.renamed", { name: original() })}
                        </span>
                      )}
                    </Show>
                    <Show when={item.role}>
                      <span class={styles.hint}>{item.role}</span>
                    </Show>
                    <Show when={item.secretRemoved}>
                      <SecretMark />
                    </Show>
                  </span>
                </label>
                <div class={review.sub} data-off={!ticks[i()]?.agent}>
                  <Show
                    when={item.instructions.length > 0}
                    fallback={<span class={styles.hint}>{t("importReview.noInstructions")}</span>}
                  >
                    <label class={review.row} data-testid="agent-import-instructions">
                      <input
                        type="checkbox"
                        checked={ticks[i()]?.instructions}
                        disabled={!ticks[i()]?.agent}
                        onChange={(e) => setTicks(i(), "instructions", e.currentTarget.checked)}
                        data-testid="agent-import-instructions-tick"
                      />
                      <span class={review.rowText}>
                        <span>
                          {t("importReview.instructions", { count: item.instructions.length })}
                        </span>
                        <Show when={item.instructions.secretRemoved}>
                          <SecretMark />
                        </Show>
                      </span>
                    </label>
                  </Show>
                  <For each={item.routines}>
                    {(routine, j) => (
                      <label class={review.row} data-testid="agent-import-routine">
                        <input
                          type="checkbox"
                          checked={ticks[i()]?.routines[j()]}
                          disabled={!ticks[i()]?.agent}
                          onChange={(e) => setTicks(i(), "routines", j(), e.currentTarget.checked)}
                          data-testid="agent-import-routine-tick"
                        />
                        <span class={review.rowText}>
                          <span>{t("importReview.routine", { name: routine.name })}</span>
                          <span class={styles.hint}>
                            {words(routine.schedule)} · {t("importReview.routine.paused")}
                          </span>
                          <Show when={routine.secretRemoved}>
                            <SecretMark />
                          </Show>
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.preview.skills.length > 0}>
          <div data-testid="skill-import">
            <h3 class={review.sectionTitle}>{t("importReview.team.skills.title")}</h3>
            <p class={review.hint}>{t("importReview.skill.off")}</p>
            <ul class={review.teamList} data-testid="skill-import-list">
              <For each={props.preview.skills}>
                {(item, i) => (
                  <li class={review.reviewItem} data-testid="skill-import-item">
                    <label class={review.tickRow}>
                      <input
                        type="checkbox"
                        checked={team.skills[i()]}
                        onChange={(e) => setTeam("skills", i(), e.currentTarget.checked)}
                        data-testid="skill-import-tick"
                      />
                      <span class={review.rowText}>
                        <span class={styles.label}>{item.name}</span>
                        <Show when={item.fileName}>
                          {(original) => (
                            <span class={styles.hint}>
                              {t("agentFile.import.renamed", { name: original() })}
                            </span>
                          )}
                        </Show>
                        <Show when={item.description}>
                          <span class={styles.hint}>{item.description}</span>
                        </Show>
                        <span class={styles.hint}>
                          <span data-testid="skill-import-agents">
                            {t("importReview.skill.agents", { names: names(item.agents) })}
                          </span>
                          {" · "}
                          {t("importReview.instructions", { count: item.instructionsLength })}
                        </span>
                        <Show when={item.secretRemoved}>
                          <SecretMark />
                        </Show>
                      </span>
                    </label>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
        <Show when={props.preview.handbook}>
          {(handbook) => (
            <div data-testid="handbook-import">
              <h3 class={review.sectionTitle}>{t("importReview.team.handbook.title")}</h3>
              <label class={review.tickRow}>
                <input
                  type="checkbox"
                  checked={team.handbook}
                  onChange={(e) => setTeam("handbook", e.currentTarget.checked)}
                  data-testid="handbook-import-tick"
                />
                <span class={review.rowText}>
                  <span>{t("importReview.handbook.length", { count: handbook().length })}</span>
                  <span class={styles.hint} data-testid="handbook-import-replaces">
                    {t("importReview.handbook.replaces")}
                  </span>
                  <Show when={handbook().secretRemoved}>
                    <SecretMark />
                  </Show>
                </span>
              </label>
              <pre class={review.handbookText} data-testid="handbook-import-text">
                {handbookText().shown}
              </pre>
              <Show when={handbookText().more}>
                <button
                  type="button"
                  class={review.link}
                  onClick={() => setShowAll(!showAll())}
                  data-testid="handbook-import-show-all"
                >
                  {showAll()
                    ? t("importReview.handbook.showLess")
                    : t("importReview.handbook.showAll")}
                </button>
              </Show>
            </div>
          )}
        </Show>
        <NotImportedList
          items={notImported()}
          channels={props.preview.channels.map((c) => c.name)}
          testId="agent-import-not-imported"
        />
        <div class={styles.field}>
          <span class={styles.label}>{t("agentFile.import.model")}</span>
          <ModelPicker value={model()} onChange={setModel} />
        </div>
        <p class={review.counts} role="status" data-testid="agent-import-counts">
          {nothing()
            ? t("importReview.nothing")
            : !hasTeam()
              ? t("importReview.counts.agents", countWords())
              : counts().agents === 0
                ? t("importReview.counts.handbookOnly")
                : `${t("importReview.counts.team", countWords())}${
                    counts().handbook ? ` ${t("importReview.counts.handbook")}` : ""
                  }`}
        </p>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="agent-import-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="agent-import-close">
            {stopped() ? t("agentFile.close") : t("agents.cancel")}
          </Button>
          <Show when={!stopped()}>
            <Button
              variant="primary"
              disabled={busy() || nothing()}
              onClick={submit}
              data-testid="agent-import-submit"
            >
              {hasTeam()
                ? t("agentFile.import.submitTeam")
                : t("agentFile.import.submit", { count: counts().agents })}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

/** Tells why a file could not be read. */
export const AgentFileProblemDialog = (props: { problem: ErrorText; onClose: () => void }) => {
  const { t } = useApp()
  return (
    <Dialog label={t("agentFile.import.title")} onClose={props.onClose} testId="agent-file-problem">
      <div class={styles.form}>
        <h2 class={styles.title}>{t("agentFile.import.title")}</h2>
        <p role="alert" class={styles.error} data-testid="agent-file-problem-text">
          {t(props.problem.key, props.problem.params)}
        </p>
        <div class={styles.actions}>
          <Button variant="primary" onClick={props.onClose}>
            {t("agentFile.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
