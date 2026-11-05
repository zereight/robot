import { createSignal, Match, Show, Switch as SwitchCase } from "solid-js"
import { AgentForm } from "../agents/AgentForm.tsx"
import { createAgent } from "../agents/createAgent.ts"
import { markBorn } from "../agents/reactions.ts"
import { ConnectForm } from "../providers/ProvidersSection.tsx"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./firstrun.module.css"

const STEPS = 3

/** The guide for a first start: look, one model account, one agent. Every step can be skipped. */
export const FirstRunDialog = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const providers = useProviders()
  const [step, setStep] = createSignal(1)
  // The new step comes in from the side that the user moves toward.
  const [direction, setDirection] = createSignal<"forward" | "back">("forward")
  const finish = () => app.update({ firstRunDone: true })
  const next = () => {
    setDirection("forward")
    setStep((s) => Math.min(STEPS, s + 1))
  }
  const connected = () => providers.accounts().find((a) => a.connected)

  return (
    <Dialog label={t("firstRun.title")} onClose={finish} dismissible={false} testId="first-run">
      <div class={styles.top}>
        <h2 class={styles.title}>{t("firstRun.title")}</h2>
        <span class={styles.step} data-testid="first-run-step">
          {t("firstRun.step", { current: step(), total: STEPS })}
        </span>
      </div>

      <SwitchCase>
        <Match when={step() === 1}>
          <section class={styles.section} data-direction={direction()} data-testid="first-run-look">
            <h3>{t("firstRun.look.title")}</h3>
            <p>{t("firstRun.look.body")}</p>
            <div class={styles.row}>
              <span>{t("settings.language")}</span>
              <Segmented
                label={t("settings.language")}
                testId="first-run-language"
                value={app.settings.language}
                onChange={(language) => app.update({ language })}
                options={[
                  { value: "system", label: t("settings.language.system") },
                  { value: "en", label: t("settings.language.en") },
                  { value: "ko", label: t("settings.language.ko") },
                ]}
              />
            </div>
            <div class={styles.row}>
              <span>{t("settings.theme")}</span>
              <Segmented
                label={t("settings.theme")}
                testId="first-run-theme"
                value={app.settings.theme}
                onChange={(theme) => app.update({ theme })}
                options={[
                  { value: "system", label: t("settings.theme.system") },
                  { value: "dark", label: t("settings.theme.dark") },
                  { value: "light", label: t("settings.theme.light") },
                ]}
              />
            </div>
          </section>
        </Match>
        <Match when={step() === 2}>
          <section
            class={styles.section}
            data-direction={direction()}
            data-testid="first-run-account"
          >
            <h3>{t("firstRun.account.title")}</h3>
            <p>{t("firstRun.account.body")}</p>
            <Show when={connected()} fallback={<ConnectForm onDone={next} />} keyed>
              {(account) => (
                <>
                  <p class={styles.ok} data-testid="first-run-connected">
                    {t("firstRun.account.connected", { name: account.name })}
                  </p>
                  <div class={styles.actions}>
                    <Button variant="primary" onClick={next} data-testid="first-run-next">
                      {t("firstRun.next")}
                    </Button>
                  </div>
                </>
              )}
            </Show>
          </section>
        </Match>
        <Match when={step() === 3}>
          <section
            class={styles.section}
            data-direction={direction()}
            data-testid="first-run-agent"
          >
            <h3>{t("firstRun.agent.title")}</h3>
            <p>{t("firstRun.agent.body")}</p>
            <AgentForm
              onCancel={finish}
              onSubmit={async (values) => {
                const serverId = ui.server()?.id
                if (!serverId) return
                const agent = await createAgent(serverId, values)
                markBorn(agent.id)
                await finish()
                ui.selectPlace({ kind: "agent", id: agent.id })
              }}
            />
          </section>
        </Match>
      </SwitchCase>

      <div class={styles.footer}>
        <Show when={step() > 1}>
          <Button
            onClick={() => {
              setDirection("back")
              setStep((s) => s - 1)
            }}
            data-testid="first-run-back"
          >
            {t("firstRun.back")}
          </Button>
        </Show>
        <span class={styles.spacer} />
        <Show when={step() === 1}>
          <Button variant="primary" onClick={next} data-testid="first-run-next">
            {t("firstRun.next")}
          </Button>
        </Show>
        <Button onClick={finish} data-testid="first-run-skip">
          {t("firstRun.skipAll")}
        </Button>
      </div>
    </Dialog>
  )
}
