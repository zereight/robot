import { createEffect, For, type JSX, onCleanup, onMount, splitProps } from "solid-js"
import styles from "./controls.module.css"

export interface SegmentOption<V extends string> {
  readonly value: V
  readonly label: string
  /** An option that is off: it shows, but the user cannot pick it. */
  readonly disabled?: boolean
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
  let box: HTMLFieldSetElement | undefined
  let thumb: HTMLSpanElement | undefined

  /** Moves the thumb under the checked option. The thumb is a clipped, full-size surface. */
  const place = (animate: boolean) => {
    const checked = box?.querySelector<HTMLElement>("label:has(input:checked)")
    if (!box || !thumb || !checked) return
    if (!animate) thumb.style.transition = "none"
    const inner = box.clientWidth - 4
    const left = checked.offsetLeft - 2
    thumb.style.setProperty("--thumb-l", `${left}px`)
    thumb.style.setProperty("--thumb-r", `${inner - left - checked.offsetWidth}px`)
    thumb.dataset.ready = "true"
    if (!animate) {
      void thumb.offsetWidth
      thumb.style.transition = ""
    }
  }
  onMount(() => {
    place(false)
    // Fonts, language and text size change the widths; the thumb follows without moving slowly.
    const observer = new ResizeObserver(() => place(false))
    if (box) observer.observe(box)
    onCleanup(() => observer.disconnect())
  })
  createEffect(() => {
    void props.value
    queueMicrotask(() => place(true))
  })
  return (
    <fieldset class={styles.segmented} data-testid={props.testId} ref={box}>
      <legend class={styles.hidden}>{props.label}</legend>
      <span class={styles.thumb} aria-hidden="true" ref={thumb} />
      <For each={props.options}>
        {(option) => (
          <label
            class={styles.segment}
            data-value={option.value}
            data-disabled={option.disabled ? "true" : undefined}
          >
            <input
              type="radio"
              class={styles.hidden}
              name={name}
              value={option.value}
              checked={props.value === option.value}
              disabled={option.disabled}
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
  /** A switch the user cannot change now. It keeps its value. */
  disabled?: boolean
}) => (
  <button
    type="button"
    role="switch"
    class={styles.switch}
    aria-label={props.label}
    aria-checked={props.checked}
    disabled={props.disabled}
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
