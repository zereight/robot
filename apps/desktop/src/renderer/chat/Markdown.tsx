import { decidePicture, type PictureBox } from "@robot/shared/pictures"
import { openableLink } from "@robot/shared/weblinks"
import { Check, Copy } from "lucide-solid"
import type { Token, Tokens } from "marked"
import {
  createContext,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./chat.module.css"
import { type Lexed, lexMarkdown } from "./lex.ts"
import { isPictureLoaded, loadPicture } from "./pictures.ts"

/** The message or article that the pictures of a Markdown text belong to. */
const PictureScope = createContext<() => string>(() => "")

const openLink = (event: MouseEvent, href: string) => {
  event.preventDefault()
  void call("app.openExternal", { url: href }).catch((e: unknown) => {
    const error = describeError(e)
    showToast("error", error.key, error.params)
  })
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

/** The words of a box: the alt text and the address, each cut, with a mark where it was cut. */
const PictureWords = (props: { box: PictureBox }) => {
  const { t } = useApp()
  return (
    <>
      <span class={styles.pictureAlt}>
        <span data-testid="picture-alt">{props.box.alt || t("picture.alt.empty")}</span>
        <Show when={props.box.altCut}>
          <span aria-hidden="true">…</span>
        </Show>
      </span>
      <span class={styles.pictureAddress}>
        <span data-testid="picture-address">{props.box.address}</span>
        <Show when={props.box.addressCut}>
          <span aria-hidden="true">…</span>
        </Show>
      </span>
    </>
  )
}

/**
 * A picture of a Markdown text. A picture from the web loads only when the user presses "Load
 * image": an address can carry data, and a load sends it to the host of the address. An `https`
 * picture is a box with a button, an `http` picture is a box with no button, and a `data:image`
 * picture shows at once because it needs no network.
 */
const PictureView = (props: { image: Tokens.Image }) => {
  const { t } = useApp()
  const scope = useContext(PictureScope)
  const picture = createMemo(() => decidePicture(props.image.href, props.image.text))
  const inline = () => {
    const p = picture()
    return p.kind === "inline" ? p : undefined
  }
  const ask = () => {
    const p = picture()
    return p.kind === "ask" ? p : undefined
  }
  const blocked = () => {
    const p = picture()
    return p.kind === "blocked" ? p : undefined
  }
  return (
    <>
      <Show when={inline()}>
        {(p) => (
          <img class={styles.image} src={p().src} alt={p().alt} referrerpolicy="no-referrer" />
        )}
      </Show>
      <Show when={ask()}>
        {(p) => (
          <Show
            when={isPictureLoaded(scope(), p().src)}
            fallback={
              <span class={styles.pictureBox} data-testid="picture-box" data-picture="ask">
                <PictureWords box={p().box} />
                <Button
                  class={styles.pictureLoad}
                  data-testid="picture-load"
                  onClick={(event) => {
                    // A picture can sit inside a link. The press loads the picture and nothing else.
                    event.preventDefault()
                    event.stopPropagation()
                    loadPicture(scope(), p().src)
                  }}
                >
                  {t("picture.load")}
                </Button>
              </span>
            }
          >
            <img
              class={styles.image}
              src={p().src}
              alt={p().alt}
              referrerpolicy="no-referrer"
              data-testid="picture-image"
            />
          </Show>
        )}
      </Show>
      <Show when={blocked()}>
        {(p) => (
          <span class={styles.pictureBox} data-testid="picture-box" data-picture="blocked">
            <PictureWords box={p().box} />
          </span>
        )}
      </Show>
    </>
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
            const href = openableLink(link.href)
            return href ? (
              <a href={href} title={link.title ?? undefined} onClick={(e) => openLink(e, href)}>
                <Inline tokens={link.tokens} />
              </a>
            ) : (
              <Inline tokens={link.tokens} />
            )
          })()}
        </Match>
        <Match when={token.type === "image"}>
          <PictureView image={token as Tokens.Image} />
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
 * Links open in the system browser. A link with no scheme opens with `https`, and a link that
 * opens nothing shows as plain words. A picture from the web shows as a box until the user loads
 * it. `scope` names the message or article that holds the text: the choice to load a picture
 * holds for one address in one scope.
 */
export const Markdown = (props: { text: string; scope: string }) => {
  // A reply grows part by part. Each reading reuses the tokens of the blocks that are done, so
  // their elements stay and only the end of the reply is read and drawn again.
  const lexed = createMemo<Lexed>((previous) => lexMarkdown(props.text, previous))
  return (
    <PictureScope.Provider value={() => props.scope}>
      <div class={styles.markdown}>
        <Blocks tokens={lexed().tokens} />
      </div>
    </PictureScope.Provider>
  )
}
