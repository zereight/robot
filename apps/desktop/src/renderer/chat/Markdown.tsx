import { Check, Copy } from "lucide-solid"
import { lexer, type Token, type Tokens } from "marked"
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { Dynamic } from "solid-js/web"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import styles from "./chat.module.css"

const safeLink = (href: string) => /^(https?:|mailto:)/i.test(href)
const safeImage = (href: string) => /^(https:|data:image\/)/i.test(href)

const openLink = (event: MouseEvent, href: string) => {
  event.preventDefault()
  if (safeLink(href)) void call("app.openExternal", { url: href })
}

const CodeBlock = (props: { code: string; lang?: string | undefined }) => {
  const { t } = useApp()
  const [copied, setCopied] = createSignal(false)
  const copy = async () => {
    await call("app.copy", { text: props.code })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div class={styles.codeBlock}>
      <div class={styles.codeTop}>
        <span>{props.lang}</span>
        <button
          type="button"
          class={styles.codeCopy}
          onClick={copy}
          aria-label={t("chat.copyCode")}
          data-testid="code-copy"
        >
          <Show when={copied()} fallback={<Copy size={14} />}>
            <Check size={14} />
          </Show>
          <span>{copied() ? t("chat.copied") : t("chat.copyCode")}</span>
        </button>
      </div>
      <pre>
        <code>{props.code}</code>
      </pre>
    </div>
  )
}

const Inline = (props: { tokens: readonly Token[] | undefined }): JSX.Element => (
  <For each={props.tokens ?? []}>
    {(token) => (
      <Switch fallback={"text" in token ? String(token.text) : token.raw}>
        <Match when={token.type === "strong"}>
          <strong>
            <Inline tokens={(token as Tokens.Strong).tokens} />
          </strong>
        </Match>
        <Match when={token.type === "em"}>
          <em>
            <Inline tokens={(token as Tokens.Em).tokens} />
          </em>
        </Match>
        <Match when={token.type === "del"}>
          <del>
            <Inline tokens={(token as Tokens.Del).tokens} />
          </del>
        </Match>
        <Match when={token.type === "codespan"}>
          <code class={styles.inlineCode}>{(token as Tokens.Codespan).text}</code>
        </Match>
        <Match when={token.type === "br"}>
          <br />
        </Match>
        <Match when={token.type === "link"}>
          {(() => {
            const link = token as Tokens.Link
            return (
              <a
                href={link.href}
                title={link.title ?? undefined}
                onClick={(e) => openLink(e, link.href)}
              >
                <Inline tokens={link.tokens} />
              </a>
            )
          })()}
        </Match>
        <Match when={token.type === "image"}>
          {(() => {
            const image = token as Tokens.Image
            return safeImage(image.href) ? (
              <img class={styles.image} src={image.href} alt={image.text} />
            ) : (
              image.text
            )
          })()}
        </Match>
        <Match when={token.type === "text" && "tokens" in token && token.tokens}>
          <Inline tokens={(token as Tokens.Text).tokens} />
        </Match>
        <Match when={token.type === "html"}>{token.raw}</Match>
      </Switch>
    )}
  </For>
)

const Blocks = (props: { tokens: readonly Token[] }): JSX.Element => (
  <For each={props.tokens}>
    {(token) => (
      <Switch fallback={null}>
        <Match when={token.type === "paragraph"}>
          <p>
            <Inline tokens={(token as Tokens.Paragraph).tokens} />
          </p>
        </Match>
        <Match when={token.type === "heading"}>
          <Dynamic
            component={`h${Math.min(6, (token as Tokens.Heading).depth + 2)}`}
            class={styles.heading}
          >
            <Inline tokens={(token as Tokens.Heading).tokens} />
          </Dynamic>
        </Match>
        <Match when={token.type === "code"}>
          <CodeBlock code={(token as Tokens.Code).text} lang={(token as Tokens.Code).lang} />
        </Match>
        <Match when={token.type === "blockquote"}>
          <blockquote>
            <Blocks tokens={(token as Tokens.Blockquote).tokens} />
          </blockquote>
        </Match>
        <Match when={token.type === "list"}>
          {(() => {
            const list = token as Tokens.List
            return (
              <Dynamic
                component={list.ordered ? "ol" : "ul"}
                start={list.ordered && list.start !== "" ? list.start : undefined}
              >
                <For each={list.items}>
                  {(item) => (
                    <li>
                      <Show when={item.task}>
                        <input type="checkbox" checked={item.checked} disabled />{" "}
                      </Show>
                      <Blocks tokens={item.tokens.filter((t) => t.type !== "checkbox")} />
                    </li>
                  )}
                </For>
              </Dynamic>
            )
          })()}
        </Match>
        <Match when={token.type === "table"}>
          {(() => {
            const table = token as Tokens.Table
            return (
              <div class={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <For each={table.header}>
                        {(cell) => (
                          <th style={{ "text-align": cell.align ?? undefined }}>
                            <Inline tokens={cell.tokens} />
                          </th>
                        )}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={table.rows}>
                      {(row) => (
                        <tr>
                          <For each={row}>
                            {(cell) => (
                              <td style={{ "text-align": cell.align ?? undefined }}>
                                <Inline tokens={cell.tokens} />
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            )
          })()}
        </Match>
        <Match when={token.type === "hr"}>
          <hr />
        </Match>
        <Match when={token.type === "text"}>
          <p>
            <Inline tokens={(token as Tokens.Text).tokens ?? [token]} />
          </p>
        </Match>
        <Match when={token.type === "html"}>
          <p>{token.raw}</p>
        </Match>
      </Switch>
    )}
  </For>
)

/**
 * Renders Markdown as elements, never as HTML. Raw HTML in the text shows as text.
 * Links open in the system browser.
 */
export const Markdown = (props: { text: string }) => {
  const tokens = createMemo(() => lexer(props.text, { gfm: true, breaks: true }))
  return (
    <div class={styles.markdown}>
      <Blocks tokens={tokens()} />
    </div>
  )
}
