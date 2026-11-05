import { CircleAlert, CircleCheck, X } from "lucide-solid"
import { For } from "solid-js"
import { useApp } from "../state/app.tsx"
import styles from "./toast.module.css"
import { dismissToast, toasts } from "./toast.ts"

/**
 * The place where toasts show. Mount it once. A success is a polite status; an error is an alert,
 * so a screen reader says it at once. The kind shows as a mark at the start of the row and the
 * tint of the surface, in place of a stripe of colour on the side (DESIGN.md).
 */
export const Toasts = () => {
  const { t } = useApp()
  return (
    <div class={styles.host} data-testid="toasts">
      <For each={toasts()}>
        {(toast) => (
          <div
            class={styles.toast}
            data-tone={toast.tone}
            role={toast.tone === "error" ? "alert" : "status"}
            data-testid={`toast-${toast.tone}`}
          >
            <span class={styles.mark} aria-hidden="true">
              {toast.tone === "error" ? <CircleAlert size={16} /> : <CircleCheck size={16} />}
            </span>
            <span class={styles.text}>{t(toast.key, toast.params)}</span>
            <button
              type="button"
              class={styles.close}
              aria-label={t("toast.dismiss")}
              onClick={() => dismissToast(toast.id)}
              data-testid="toast-dismiss"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </For>
    </div>
  )
}
