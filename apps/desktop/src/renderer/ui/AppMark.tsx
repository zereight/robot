/**
 * The app mark without its tile: two smiling eyes that glow. The same shapes as
 * `resources/icon.svg`. For dark surfaces only. `size` is the width; the height follows.
 */
export const AppMark = (props: { size: number }) => (
  <svg
    width={props.size}
    height={Math.round((props.size * 165) / 635)}
    viewBox="194.6 414 635 165"
    aria-hidden="true"
    data-testid="app-mark"
    style={{ "flex-shrink": 0, display: "block", filter: "drop-shadow(0 0 2px #7affd4)" }}
  >
    <g fill="#eafff8">
      <path d="M204.6 569 A145 145 0 0 1 494.6 569 A43.5 43.5 0 0 1 407.6 569 A58 58 0 0 0 291.6 569 A43.5 43.5 0 0 1 204.6 569 Z" />
      <path d="M529.4 569 A145 145 0 0 1 819.4 569 A43.5 43.5 0 0 1 732.4 569 A58 58 0 0 0 616.4 569 A43.5 43.5 0 0 1 529.4 569 Z" />
    </g>
  </svg>
)
