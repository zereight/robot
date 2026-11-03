import type { MessageKey, MessageParams, OutsideSource } from "@robot/shared"

type Translate = (key: MessageKey, params?: MessageParams) => string

/** The words for the first source of outside content (spec 007): a host, a tool, a routine, an agent, Teams. */
export const outsideSourceText = (t: Translate, source: OutsideSource): string => {
  switch (source.kind) {
    case "page":
      return source.host
        ? t("outside.source.page", { host: source.host })
        : t("outside.source.pageUnknown")
    case "connection":
      return t("outside.source.connection", { connection: source.connection, tool: source.tool })
    case "secret":
      return t("outside.source.secret", { name: source.name })
    case "routine":
      return t("outside.source.routine", { name: source.name })
    case "agent":
      return t("outside.source.agent", { name: source.name })
    case "teams":
      return t("outside.source.teams")
  }
}
