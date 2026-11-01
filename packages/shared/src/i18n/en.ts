/** English catalogue. It is the source: every key here must exist in every other catalogue. */
export const en = {
  "app.name": "ROBot",

  "settings.title": "Settings",
  "settings.close": "Close settings",
  "settings.section.general": "General",
  "settings.section.appearance": "Appearance",
  "settings.section.providers": "Providers",
  "settings.section.devices": "Devices",
  "settings.section.notifications": "Notifications",
  "settings.section.archive": "Archive",
  "settings.section.data": "Data",
  "settings.section.about": "About",
  "settings.later": "This part comes in a later version.",

  "settings.language": "Language",
  "settings.language.system": "Follow the system",
  "settings.language.en": "English",
  "settings.language.ko": "한국어",
  "settings.startAtLogin": "Start at login",
  "settings.startAtLogin.hint": "Open ROBot when you sign in to this computer.",
  "settings.workspaceRoot": "Agent workspaces folder",
  "settings.workspaceRoot.hint": "New agents get a folder here.",
  "settings.workspaceRoot.change": "Change…",
  "settings.workspaceRoot.reset": "Use default",

  "settings.theme": "Theme",
  "settings.theme.system": "Follow the system",
  "settings.theme.dark": "Dark",
  "settings.theme.light": "Light",
  "settings.textSize": "Text size",
  "settings.textSize.small": "Small",
  "settings.textSize.default": "Default",
  "settings.textSize.large": "Large",
  "settings.compactPlaces": "Compact place list",
  "settings.compactPlaces.hint": "Show more places with shorter rows.",
  "settings.reduceMotion": "Reduce motion",
  "settings.reduceMotion.system": "Follow the system",
  "settings.reduceMotion.on": "On",
  "settings.reduceMotion.off": "Off",

  "settings.data.folder": "Data folder",
  "settings.data.folder.hint": "Your database and attachments are here.",
  "settings.data.open": "Open folder",

  "settings.about.version": "Version {version}",
  "settings.about.licenses": "Open source licenses",
  "settings.about.licenses.count": "{count} packages",

  "home.title": "Welcome to ROBot",
  "home.body": "Your agents will show here.",
  "home.openSettings": "Open settings",
} as const

export type MessageKey = keyof typeof en
