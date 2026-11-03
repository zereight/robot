import type { MessageKey, MessageParams, SensitiveLabel } from "@robot/shared"

type Translate = (key: MessageKey, params?: MessageParams) => string

/** The words for the label of a credential place (spec 007, "Sensitive places"): "Keys", "Keychain". */
export const sensitiveLabelText = (t: Translate, label: SensitiveLabel): string =>
  t(`sensitive.label.${label}` as MessageKey)
