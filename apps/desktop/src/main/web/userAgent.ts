/**
 * The user agent that the pages of the agent browser send.
 *
 * Electron adds two tokens to the user agent of Chromium: its own (`Electron/<version>`) and the
 * name of the app. Some sites read the `Electron/` token and send the page to an error screen
 * with no text. Microsoft Teams does this. The browser is Chromium, so it says what Chromium says.
 * The function is safe to call again on its own result.
 */
export const pageUserAgent = (raw: string, appName: string): string => {
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return raw
    .replace(/\sElectron\/\S+/g, "")
    .replace(new RegExp(`\\s${escaped}\\/\\S+`, "g"), "")
    .trim()
}
