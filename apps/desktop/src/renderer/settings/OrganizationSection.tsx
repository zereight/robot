import { HAND_OFF_RULES, type HandOffRule, type MessageKey } from "@robot/shared"
import { createResource, createSignal, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Segmented } from "../ui/controls.tsx"
import settings from "./settings.module.css"

/**
 * Settings, Organization (spec 013, 030): the hand-off rule, "Any agent" or "Along the channels".
 * A change counts from the next send. The part syncs with the other computer (spec 019). A linked
 * computer reads the part of its server and does not change it, with the switch "Can create and
 * change agents" or without it (spec 012). The switch "Ask up the line" joins this part in a later
 * slice (spec 030).
 */
export const OrganizationSection = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const serverId = () => (ui.serverOffline() ? undefined : ui.server()?.id)
  const [organization, { refetch }] = createResource(serverId, (id) =>
    call("organization.get", { serverId: id }),
  )
  onCleanup(
    window.robot.on("organization.changed", (e) => {
      if (e.serverId === serverId()) void refetch()
    }),
  )
  const [error, setError] = createSignal<ErrorText>()

  const readOnly = () => ui.linked()
  const rule = (): HandOffRule => organization()?.handOff ?? "any"
  const change = async (next: HandOffRule) => {
    if (readOnly() || next === rule()) return
    setError(undefined)
    try {
      await call("organization.setHandOff", { rule: next })
      await refetch()
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <div data-testid="organization-section">
      <p class={settings.note}>{t("organization.hint")}</p>
      <Show when={ui.linked()}>
        <p class={settings.note} data-testid="organization-remote">
          {t("organization.remote", { name: ui.server()?.name ?? "" })}
        </p>
      </Show>
      <Show
        when={!ui.serverOffline()}
        fallback={
          <p class={settings.note} data-testid="organization-offline">
            {t("organization.offline", { name: ui.server()?.name ?? "" })}
          </p>
        }
      >
        <div class={settings.row} data-testid="organization-hand-off-row">
          <div>
            <div class={settings.label}>{t("organization.handOff")}</div>
            <div class={settings.hint}>{t("organization.handOff.hint")}</div>
            <div class={settings.hint} data-testid="organization-hand-off-now">
              {t(`organization.handOff.now.${rule()}` as MessageKey)}
            </div>
          </div>
          <Segmented
            label={t("organization.handOff")}
            testId="organization-hand-off"
            value={rule()}
            onChange={(next) => void change(next)}
            options={HAND_OFF_RULES.map((value) => ({
              value,
              label: t(`organization.handOff.${value}` as MessageKey),
              disabled: readOnly(),
            }))}
          />
        </div>
        <Show when={ui.linked()}>
          <p class={settings.note} data-testid="organization-readonly">
            {t("organization.readonly", { name: ui.server()?.name ?? "" })}
          </p>
        </Show>
        <p class={settings.note} data-testid="organization-syncs">
          {t("organization.syncs")}
        </p>
        <Show when={error()}>
          {(err) => (
            <p class={settings.error} role="alert" data-testid="organization-error">
              {t(err().key, err().params)}
            </p>
          )}
        </Show>
      </Show>
    </div>
  )
}
