import type { ServerView } from "@robot/phone"
import type { AppValue } from "../state/context.tsx"

/** The line for the connection state of a server (spec 012, "States"). */
export const stateText = (t: AppValue["t"], view: ServerView): string => {
  const name = view.link.name
  switch (view.state) {
    case "connecting":
      return t("state.connecting")
    case "online":
      return t("state.online")
    case "reconnecting":
      return t("state.reconnecting")
    case "offline":
      return t("state.offline")
    case "not_allowed":
      return t("state.not_allowed", { name })
    case "update_app":
      return view.updateSide === "this"
        ? t("state.update_app.this")
        : t("state.update_app.server", { name })
  }
}

/** The colour of the dot of a state: green online, grey on the way, red when it cannot open. */
export const stateTone = (state: ServerView["state"]): "good" | "busy" | "bad" | "off" =>
  state === "online"
    ? "good"
    : state === "connecting" || state === "reconnecting"
      ? "busy"
      : state === "offline"
        ? "off"
        : "bad"
