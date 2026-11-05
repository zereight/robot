/**
 * Lights the rose halo once on a control, as the answer to an action the user just did
 * (DESIGN.md, "Answer Rose"). The animation lives in global.css under `[data-echo]`. It is off
 * with reduce motion, because the motion durations are 0 then.
 */
export const echo = (el: HTMLElement | null | undefined): void => {
  if (!el?.isConnected) return
  el.removeAttribute("data-echo")
  // Reading the layout restarts the animation when the user acts twice in a row.
  void el.offsetWidth
  el.setAttribute("data-echo", "true")
  // A child can animate too (the icon of the send button), and its end bubbles up to here.
  const off = (event: AnimationEvent) => {
    if (event.target !== el || event.animationName !== "echo") return
    el.removeAttribute("data-echo")
    el.removeEventListener("animationend", off)
  }
  el.addEventListener("animationend", off)
}
