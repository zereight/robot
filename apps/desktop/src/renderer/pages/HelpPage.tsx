import styles from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"

export const HelpPage = () => {
  const app = useApp()
  const { t } = app
  const mod = app.info.platform === "darwin" ? "⌘" : "Ctrl"
  return (
    <div class={styles.page} data-testid="help-page">
      <h1>{t("help.shortcuts")}</h1>
      <dl class={styles.shortcuts}>
        <dt>{mod} K</dt>
        <dd>{t("help.shortcut.search")}</dd>
        <dt>↑ ↓</dt>
        <dd>{t("help.shortcut.move")}</dd>
        <dt>Enter</dt>
        <dd>{t("help.shortcut.open")}</dd>
        <dt>Esc</dt>
        <dd>{t("help.shortcut.clear")}</dd>
      </dl>
    </div>
  )
}
