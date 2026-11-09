import type { Settings } from "@robot/shared"

/**
 * The language of the native file dialogs. The platform cannot read the settings store, so the
 * startup and the settings update set it here, next to the theme (spec 013). Until then the
 * dialogs follow the system.
 */
let dialogLanguage: Settings["language"] = "system"

/** Sets the language of the native file dialogs. */
export const setDialogLanguage = (language: Settings["language"]): void => {
  dialogLanguage = language
}

/** The language of the native file dialogs. */
export const getDialogLanguage = (): Settings["language"] => dialogLanguage
