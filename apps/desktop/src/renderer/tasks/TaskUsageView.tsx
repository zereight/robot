import { cachedShare, hasUsage, type TaskUsage, type TreeUsage } from "@robot/shared"
import { For, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import styles from "./tasks.module.css"
import { formatCost, formatCount } from "./usageText.ts"

/**
 * The numbers of one usage: input, output, the cached share and the cost (spec 005, "Usage of a
 * task"). A number that the provider did not report shows as "—", never as 0. The cached share and
 * the cost show only when the provider reports them.
 */
const Numbers = (props: { usage: TaskUsage; id: string }) => {
  const { t, locale } = useApp()
  const share = () => cachedShare(props.usage)
  return (
    <dl class={styles.times} data-testid={`${props.id}-numbers`}>
      <div>
        <dt>{t("taskUsage.input")}</dt>
        <dd data-testid={`${props.id}-input`} data-tokens={props.usage.input ?? ""}>
          {formatCount(locale(), props.usage.input)}
        </dd>
      </div>
      <div>
        <dt>{t("taskUsage.output")}</dt>
        <dd data-testid={`${props.id}-output`} data-tokens={props.usage.output ?? ""}>
          {formatCount(locale(), props.usage.output)}
        </dd>
      </div>
      <Show when={share() !== null}>
        <div>
          <dt>{t("taskUsage.cached")}</dt>
          <dd data-testid={`${props.id}-cached`} data-percent={share() ?? ""}>
            {share()}%
          </dd>
        </div>
      </Show>
      <Show when={props.usage.costMicros !== null}>
        <div>
          <dt>{t("taskUsage.cost")}</dt>
          <dd data-testid={`${props.id}-cost`}>
            {formatCost(locale(), props.usage.costMicros as number)}
          </dd>
        </div>
      </Show>
    </dl>
  )
}

/**
 * The usage in the task view: the task itself, and for a task with child tasks the total of the
 * whole tree with one line for each agent, the largest total first (spec 005).
 */
export const TaskUsageView = (props: { usage: TaskUsage; tree: TreeUsage | null }) => {
  const { t, locale } = useApp()
  return (
    <section data-testid="task-usage">
      <h3>{t("taskUsage.title")}</h3>
      <Numbers usage={props.usage} id="task-usage" />
      <Show when={props.tree}>
        {(tree) => (
          <>
            <h3>{t("taskUsage.tree")}</h3>
            <Numbers usage={tree().total} id="task-tree" />
            <h3>{t("taskUsage.byAgent")}</h3>
            <ul class={styles.usageLines} data-testid="task-tree-lines">
              <For each={tree().lines}>
                {(line) => (
                  <li data-testid="task-tree-line" data-agent={line.agentName}>
                    <span class={styles.usageAgent}>{line.agentName}</span>
                    <Show
                      when={hasUsage(line.usage)}
                      fallback={
                        <span class={styles.muted} data-testid="task-tree-line-none">
                          {t("taskUsage.none")}
                        </span>
                      }
                    >
                      <span data-testid="task-tree-line-numbers">
                        {t("taskUsage.line", {
                          input: formatCount(locale(), line.usage.input),
                          output: formatCount(locale(), line.usage.output),
                        })}
                      </span>
                      <Show when={line.share !== null}>
                        <span class={styles.muted} data-testid="task-tree-line-share">
                          {t("taskUsage.share", { percent: line.share ?? 0 })}
                        </span>
                      </Show>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </section>
  )
}
