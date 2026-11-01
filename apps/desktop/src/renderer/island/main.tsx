import {
  type IslandState,
  islandShape,
  type MessageKey,
  resolveLocale,
  translate,
} from "@robot/shared"
import { Bot } from "lucide-solid"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { render } from "solid-js/web"
import { Face } from "../agents/Face.tsx"
import { call } from "../lib/rpc.ts"
import "./island.css"

const [settings, info] = await Promise.all([call("settings.get"), call("app.info")])
const locale = resolveLocale(settings.language, info.systemLocale)
const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(locale, key, params)
const noMotion = settings.reduceMotion === "on"

const Island = () => {
  const [state, setState] = createSignal<IslandState>(initialState)
  onCleanup(window.robot.on("island.state", setState))
  const shape = () => islandShape(state())
  return (
    <div
      class="island"
      data-shape={shape()}
      data-motion={noMotion ? "off" : "on"}
      data-testid="island"
    >
      <Show
        when={state().attention}
        fallback={
          <div class="bar" data-testid="island-bar">
            <Bot size={16} aria-label="ROBot" />
            <span class="spacer" />
            <Show
              when={state().count > 0}
              fallback={<span class="dot" data-testid="island-idle" />}
            >
              <span class="faces" data-testid="island-working">
                <For each={state().working}>
                  {(a) => (
                    <span class="face" title={a.name}>
                      <Face face={a.face} size={22} />
                    </span>
                  )}
                </For>
              </span>
              <span class="count" data-testid="island-count">
                {state().count}
              </span>
            </Show>
          </div>
        }
      >
        {(a) => (
          <div class="card" data-testid="island-attention">
            <div class="head">
              <Face face={a().agent.face} size={30} />
              <div class="text">
                <strong>{a().agent.name}</strong>
                <span class="summary" data-testid="island-summary">
                  {a().summary}
                </span>
              </div>
            </div>
            <div class="buttons">
              <Show when={a().kind === "approval"}>
                <button
                  type="button"
                  class="primary"
                  data-testid="island-allow"
                  onClick={() =>
                    call("island.respond", {
                      agentId: a().agentId,
                      callId: a().callId,
                      answer: "allow",
                    })
                  }
                >
                  {t("chat.tool.allow")}
                </button>
                <button
                  type="button"
                  data-testid="island-deny"
                  onClick={() =>
                    call("island.respond", {
                      agentId: a().agentId,
                      callId: a().callId,
                      answer: "deny",
                    })
                  }
                >
                  {t("chat.tool.deny")}
                </button>
              </Show>
              <button
                type="button"
                data-testid="island-open"
                onClick={() => call("island.openApp", { target: a().target })}
              >
                {t("island.open")}
              </button>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

const initialState: IslandState = await call("island.get")
const root = document.getElementById("root")
if (root) render(() => <Island />, root)
