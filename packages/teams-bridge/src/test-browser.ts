import { type Browser, chromium } from "playwright-core"

/**
 * Starts the installed Chrome without a window. Returns null when Chrome is not there,
 * so that a computer with no Chrome skips the browser tests and does not fail them.
 */
export async function launchChrome(): Promise<Browser | null> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true })
  } catch {
    console.warn("Chrome not found: the browser tests of teams-bridge are skipped.")
    return null
  }
}
