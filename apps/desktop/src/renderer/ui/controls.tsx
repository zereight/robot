import { For, type JSX, splitProps } from "solid-js"
import styles from "./controls.module.css"

export interface SegmentOption<V extends string> {
  readonly value: V
  readonly label: string
}

let groupCount = 0

/** A row of mutually exclusive choices, built on native radio buttons. */
export const Segmented = <V extends string>(props: {
  label: string
  value: V
  options: readonly SegmentOption<V>[]
  onChange: (value: V) => void
  testId?: string
}) => {
  const name = `segmented-${++groupCount}`
  return (
    <fieldset class={styles.segmented} data-testid={props.testId}>
      <legend class={styles.hidden}>{props.label}</legend>
      <For each={props.options}>
        {(option) => (
          <label class={styles.segment} data-value={option.value}>
            <input
              type="radio"
              class={styles.hidden}
              name={name}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            {option.label}
          </label>
        )}
      </For>
    </fieldset>
  )
}

export const Switch = (props: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  testId?: string
}) => (
  <button
    type="button"
    role="switch"
    class={styles.switch}
    aria-label={props.label}
    aria-checked={props.checked}
    data-testid={props.testId}
    onClick={() => props.onChange(!props.checked)}
  />
)

export const Button = (
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "default" },
) => {
  const [local, rest] = splitProps(props, ["variant", "class"])
  return (
    <button
      type="button"
      class={`${local.variant === "primary" ? styles.primary : styles.button} ${local.class ?? ""}`}
      {...rest}
    />
  )
}

export const IconButton = (
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { label: string },
) => {
  const [local, rest] = splitProps(props, ["label", "class"])
  return (
    <button
      type="button"
      class={`${styles.iconButton} ${local.class ?? ""}`}
      aria-label={local.label}
      title={local.label}
      {...rest}
    />
  )
}
