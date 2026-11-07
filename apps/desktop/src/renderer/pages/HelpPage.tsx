import styles from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"

/**
 * The keys of the app (spec 001, "Rules", "Keyboard"; spec 003, flows 1 and 10). Each line names a
 * key that works. A key that the spec leaves open is not listed (docs/spec-questions.md).
 */
export const HelpPage = () => {
  const app = useApp()
  const { t } = app
  const mod = app.info.platform === "darwin" ? "⌘" : "Ctrl"
  return (
    <div class={styles.page} data-testid="help-page">
      <h1>{t("help.shortcuts")}</h1>
      <dl class={styles.shortcuts}>
        <dt>{mod} F</dt>
        <dd>{t("help.shortcut.find")}</dd>
        <dt>Enter</dt>
        <dd>{t("help.shortcut.send")}</dd>
        <dt>Shift Enter</dt>
        <dd>{t("help.shortcut.newline")}</dd>
        <dt>Enter</dt>
        <dd>{t("help.shortcut.findNext")}</dd>
        <dt>Shift Enter</dt>
        <dd>{t("help.shortcut.findPrevious")}</dd>
        <dt>Esc</dt>
        <dd>{t("help.shortcut.findClose")}</dd>
      </dl>
    </div>
  )
}
