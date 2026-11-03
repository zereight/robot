import { chmodSync, mkdirSync } from "node:fs"
import { type BrowserContext, chromium, type Page } from "playwright-core"
import type { Config } from "./config.ts"

/**
 * Opens the installed browser with a separate profile folder.
 * The folder keeps the Teams sign-in, so it is as sensitive as the account:
 * mode 0700, and keep it out of backups and sync.
 */
export async function openProfile(cfg: Config): Promise<{ context: BrowserContext; page: Page }> {
  mkdirSync(cfg.profileDir, { recursive: true, mode: 0o700 })
  chmodSync(cfg.profileDir, 0o700)
  const context = await chromium.launchPersistentContext(cfg.profileDir, {
    channel: cfg.browserChannel,
    headless: false,
    viewport: null,
  })
  const page = context.pages()[0] ?? (await context.newPage())
  return { context, page }
}
