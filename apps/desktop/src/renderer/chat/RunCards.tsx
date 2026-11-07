import type { CardAnswer, MessageKey, RunCard } from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { outsideText, sensitiveText } from "../lib/runText.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./cards.module.css"

const answerCard = (cardId: string, answer: CardAnswer) =>
  void call("cards.answer", { cardId, answer }).catch((e: unknown) => {
    const text = describeError(e)
    showToast("error", text.key, text.params)
  })

const Origin = (props: { card: RunCard }) => {
  const { t } = useApp()
  return (
    <span class={styles.origin}>
      {props.card.nodeNumber !== null
        ? t("cards.from", { number: props.card.nodeNumber, name: props.card.nodeName ?? "" })
        : t("cards.fromChat")}
    </span>
  )
}

const Marks = (props: { card: RunCard }) => {
  const { t } = useApp()
  return (
    <>
      <Show when={props.card.outside}>
        {(source) => (
          <p class={styles.mark} data-testid="card-outside">
            {t("cards.outside", { source: outsideText(t, source()) })}
          </p>
        )}
      </Show>
      <Show when={props.card.sensitive}>
        {(label) => (
          <p class={styles.mark} data-testid="card-sensitive">
            {t("cards.sensitive", { label: sensitiveText(t, label()) })}
          </p>
        )}
      </Show>
      <Show when={props.card.unreadable}>
        <p class={styles.mark}>{t("cards.unreadable")}</p>
      </Show>
    </>
  )
}

const Approval = (props: { card: RunCard }) => {
  const { t } = useApp()
  return (
    <div
      class={styles.card}
      role="alert"
      aria-label={t("cards.title.approval")}
      data-testid="card-approval"
      data-card-id={props.card.id}
    >
      <div class={styles.head}>
        <strong>{t("cards.title.approval")}</strong>
        <Show when={props.card.step}>
          {(step) => <span class={styles.step}>{t(`cards.step.${step()}` as MessageKey)}</span>}
        </Show>
        <Origin card={props.card} />
      </div>
      <pre class={styles.summary} tabindex="0" data-testid="card-summary">
        {props.card.summary}
      </pre>
      <Marks card={props.card} />
      <div class={styles.buttons}>
        <Button
          variant="primary"
          onClick={() => answerCard(props.card.id, { kind: "approval", answer: "allow" })}
          data-testid="card-allow"
        >
          {t("cards.allow")}
        </Button>
        <Show when={!props.card.once}>
          <Button
            onClick={() => answerCard(props.card.id, { kind: "approval", answer: "always" })}
            data-testid="card-always"
          >
            {t("cards.always")}
          </Button>
        </Show>
        <Button
          variant="danger"
          onClick={() => answerCard(props.card.id, { kind: "approval", answer: "deny" })}
          data-testid="card-deny"
        >
          {t("cards.deny")}
        </Button>
      </div>
    </div>
  )
}

const Question = (props: { card: RunCard }) => {
  const { t } = useApp()
  const [text, setText] = createSignal("")
  const send = () => {
    if (text().trim() !== "") answerCard(props.card.id, { kind: "question", text: text().trim() })
  }
  return (
    <div
      class={styles.card}
      role="status"
      aria-live="polite"
      aria-label={t("cards.title.question")}
      data-testid="card-question"
      data-card-id={props.card.id}
    >
      <div class={styles.head}>
        <strong>{t("cards.title.question")}</strong>
        <Origin card={props.card} />
      </div>
      <p class={styles.summary} data-testid="card-summary">
        {props.card.summary}
      </p>
      <Show when={props.card.choices.length > 0}>
        <div class={styles.buttons}>
          <For each={props.card.choices}>
            {(choice) => (
              <Button onClick={() => answerCard(props.card.id, { kind: "question", text: choice })}>
                {choice}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <div class={styles.buttons}>
        <input
          type="text"
          class={styles.input}
          value={text()}
          placeholder={t("cards.question.placeholder")}
          aria-label={t("cards.question.placeholder")}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          data-testid="card-question-input"
        />
        <Button variant="primary" onClick={send} data-testid="card-question-send">
          {t("cards.question.send")}
        </Button>
      </div>
      <p class={styles.hint}>{t("cards.question.hint")}</p>
    </div>
  )
}

const Pick = (props: { card: RunCard }) => {
  const { t } = useApp()
  const why = () =>
    props.card.pickReason === "threshold" || props.card.pickReason === null
      ? t("cards.pick.reason.threshold", { threshold: props.card.threshold ?? 0 })
      : t(`cards.pick.reason.${props.card.pickReason}` as MessageKey)
  return (
    <div
      class={styles.card}
      role="status"
      aria-live="polite"
      aria-label={t("cards.title.pick")}
      data-testid="card-pick"
      data-card-id={props.card.id}
    >
      <div class={styles.head}>
        <strong>{t("cards.title.pick")}</strong>
        <Origin card={props.card} />
      </div>
      <p class={styles.summary} data-testid="card-summary">
        {props.card.summary}
      </p>
      <p class={styles.hint}>{why()}</p>
      <div class={styles.buttons}>
        <For each={props.card.options}>
          {(option) => (
            <Button
              onClick={() => answerCard(props.card.id, { kind: "pick", optionId: option.id })}
              data-testid={`card-pick-${option.label}`}
            >
              {option.label}
              <Show when={option.probability !== null}>
                {" "}
                {Math.round((option.probability ?? 0) * 100)}%
              </Show>
            </Button>
          )}
        </For>
      </div>
    </div>
  )
}

/** The node asks the user to take over the browser (spec 007). The page shows under the chat. */
const Control = (props: { card: RunCard }) => {
  const { t } = useApp()
  const place = () => props.card.control?.place ?? null
  return (
    <div
      class={styles.card}
      role="status"
      aria-live="polite"
      aria-label={t("cards.title.control")}
      data-testid="card-control"
      data-card-id={props.card.id}
    >
      <div class={styles.head}>
        <strong>{t("cards.title.control")}</strong>
        <Origin card={props.card} />
      </div>
      <p class={styles.summary} data-testid="card-summary">
        {props.card.summary}
      </p>
      <Show when={props.card.control?.host}>
        {(host) => <p class={styles.hint}>{t("cards.control.host", { host: host() })}</p>}
      </Show>
      <Show when={place()}>
        {(where) => (
          <p class={styles.mark} data-testid="card-control-place">
            {where().kind === "frame"
              ? t("cards.control.frame", { site: (where() as { site: string }).site })
              : t("cards.control.page")}
          </p>
        )}
      </Show>
      <p class={styles.hint}>{t("cards.control.hint")}</p>
      <div class={styles.buttons}>
        <Button
          variant="primary"
          onClick={() => answerCard(props.card.id, { kind: "control" })}
          data-testid="card-control-give-back"
        >
          {t("cards.control.giveBack")}
        </Button>
      </div>
    </div>
  )
}

/** A card that the user answered: one line (spec 003). */
const Answered = (props: { card: RunCard }) => {
  const { t } = useApp()
  const line = () => {
    const card = props.card
    const answer = card.answer ?? ""
    if (card.kind === "control") return t("cards.answered.control")
    if (card.kind === "approval") return t(`cards.answered.${answer}` as MessageKey)
    if (card.kind === "question")
      return card.answeredInChat
        ? t("cards.answered.chat", { text: answer })
        : t("cards.answered.question", { text: answer })
    return t("cards.answered.pick", {
      label: card.options.find((o) => o.id === answer)?.label ?? "",
    })
  }
  return (
    <p class={styles.answered} data-testid="card-answered">
      <Origin card={props.card} /> · {props.card.summary.slice(0, 80)} — {line()}
    </p>
  )
}

/** The cards of the chat: those that wait, and those answered lately (spec 003, 007). */
export const RunCards = (props: { cards: readonly RunCard[] }) => (
  <div class={styles.list} data-testid="chat-cards">
    <For each={props.cards}>
      {(card) => (
        <Show when={card.answeredAt === null} fallback={<Answered card={card} />}>
          {card.kind === "approval" ? (
            <Approval card={card} />
          ) : card.kind === "question" ? (
            <Question card={card} />
          ) : card.kind === "control" ? (
            <Control card={card} />
          ) : (
            <Pick card={card} />
          )}
        </Show>
      )}
    </For>
  </div>
)
