import type { OrgBlock, OrgList } from "@robot/shared"
import { ChevronRight } from "lucide-solid"
import { createMemo, For, type JSX, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { useApp } from "../state/app.tsx"
import styles from "./orglist.module.css"
import { blockLine, blockName, outcomeLineOf, type Translate } from "./orglistText.ts"

// The list view of the org chart (spec 029, "Search and the list"). It draws the same rows as the
// screen of the phone, from the same builder in the shared package, so the two never disagree. The
// canvas and the list show one chart: this file only chooses how to read it.

/** One block of the list: its organization, its members and its sub-organizations. */
const blockLabel = (t: Translate, block: OrgBlock) => blockName(t, block)

const Row = (props: {
  onClick?: () => void
  children: JSX.Element
  testId: string
  dim: boolean
}) => (
  <li>
    <button
      type="button"
      class={styles.row}
      data-dim={props.dim}
      data-testid={props.testId}
      onClick={() => props.onClick?.()}
    >
      {props.children}
    </button>
  </li>
)

/**
 * The list of the org chart. `dim` is the set of node keys that the search does not match; an empty
 * set means that every row is at full contrast. A row dims when neither it nor its block matches,
 * as a node dims on the canvas.
 */
export const OrgListView = (props: {
  list: OrgList
  dim: ReadonlySet<string>
  onAgent: (agentId: string) => void
  onOrg: (orgId: string) => void
}) => {
  // The hand-off block has no key of its own in the model, so it dims only when nothing matches.
  return (
    <div class={styles.page} data-testid="org-list">
      <Show when={props.list.root.kind === "you"}>
        <div class={styles.you} data-testid="org-list-you">
          {useApp().t("orgchart.you")}
        </div>
      </Show>
      <ol class={styles.blocks}>
        <For each={props.list.blocks}>
          {(block) => (
            <Block block={block} dim={props.dim} onAgent={props.onAgent} onOrg={props.onOrg} />
          )}
        </For>
      </ol>
      <Show when={props.list.handoffs.length > 0}>
        <section
          class={styles.handoffs}
          data-dim={props.dim.size > 0}
          data-testid="org-list-handoffs"
        >
          <h3 class={styles.handoffTitle}>{useApp().t("orgchart.legend.handoff")}</h3>
          <ul class={styles.rows}>
            <For each={props.list.handoffs}>
              {(line) => (
                <li class={styles.handoffRow} data-testid="org-list-handoff">
                  <span class={styles.handoffNames}>
                    {line.from} → {line.to}
                  </span>
                  <span class={styles.count}>{line.count}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  )
}

const Block = (props: {
  block: OrgBlock
  dim: ReadonlySet<string>
  onAgent: (agentId: string) => void
  onOrg: (orgId: string) => void
}) => {
  const { t } = useApp()
  /** The key of the block in the model: it is the key of its organization node. */
  const key = () => props.block.key
  const blockDim = () => props.dim.size > 0 && !props.dim.has(key())
  const goal = createMemo(() => (props.block.orgId === null ? null : props.block.goal))
  return (
    <li
      class={styles.block}
      style={{ "--level": props.block.level - 1 }}
      data-dim={blockDim()}
      data-level={props.block.level}
      data-testid="org-list-block"
    >
      <button
        type="button"
        class={styles.blockHead}
        data-testid="org-list-block-head"
        onClick={() => {
          if (props.block.orgId !== null) props.onOrg(props.block.orgId)
        }}
      >
        <span class={styles.blockName}>{blockLabel(t, props.block)}</span>
        <span class={styles.blockLine}>{blockLine(t, props.block)}</span>
        <Show when={outcomeLineOf(t, props.block) !== ""}>
          <span class={styles.outcome} data-testid="org-list-outcome">
            {outcomeLineOf(t, props.block)}
          </span>
        </Show>
        <Show when={goal()}>
          {(text) => (
            <span class={styles.goal} data-testid="org-list-goal">
              {text()}
            </span>
          )}
        </Show>
      </button>
      <ul class={styles.rows}>
        <For each={props.block.rows}>
          {(row) => (
            <Row
              testId="org-list-agent"
              dim={props.dim.size > 0 && !props.dim.has(row.key)}
              onClick={() => props.onAgent(row.agentId)}
            >
              <Face face={row.face} size={20} agentId={row.agentId} />
              <span class={styles.agentName}>{row.name}</span>
              <Show when={row.isLead}>
                <span class={styles.lead} data-testid="org-list-lead">
                  {t("orgchart.lead")}
                </span>
              </Show>
              <ChevronRight size={14} class={styles.chevron ?? ""} aria-hidden="true" />
            </Row>
          )}
        </For>
      </ul>
    </li>
  )
}
