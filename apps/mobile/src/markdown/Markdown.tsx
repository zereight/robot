import type { Picture, PictureBox } from "@robot/shared/pictures"
import * as Clipboard from "expo-clipboard"
import { createContext, memo, useContext, useMemo, useState } from "react"
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { useApp } from "../state/context.tsx"
import { radius, space, text } from "../theme/palette.ts"
import { Button } from "../ui/kit.tsx"
import { loadPicture, usePictureLoaded } from "./loaded.ts"
import { type Block, type Inline, parseMarkdown } from "./parse.ts"

const mono = "Menlo"

/** The message that the pictures of a Markdown text belong to. */
const PictureScope = createContext("")

/**
 * The Markdown of a reply (spec 003), drawn with native views. See parse.ts for the rules. A
 * picture from the web is a box until the user loads it. `scope` names the message: the choice
 * to load a picture holds for one address in one scope.
 */
export const Markdown = memo((props: { readonly source: string; readonly scope: string }) => {
  const blocks = useMemo(() => parseMarkdown(props.source), [props.source])
  return (
    <PictureScope.Provider value={props.scope}>
      <View style={styles.blocks}>
        {blocks.map((block, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no id; the order is stable.
          <BlockView key={i} block={block} />
        ))}
      </View>
    </PictureScope.Provider>
  )
})

const BlockView = ({ block }: { readonly block: Block }) => {
  const { palette } = useApp()
  switch (block.kind) {
    case "paragraph":
      return <Inlines list={block.inlines} />
    case "heading":
      return (
        <Inlines
          list={block.inlines}
          heading
          style={{
            fontSize: block.level <= 1 ? text.xl : block.level === 2 ? text.l : text.m,
            fontWeight: "700",
          }}
        />
      )
    case "code":
      return <CodeBlock code={block.text} />
    case "quote":
      return (
        <View style={[styles.quote, { borderLeftColor: palette.border }]}>
          {block.blocks.map((b, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no id; the order is stable.
            <BlockView key={i} block={b} />
          ))}
        </View>
      )
    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items have no id; the order is stable.
            <View key={i} style={styles.item}>
              <Text style={[styles.body, { color: palette.textMuted }]}>
                {block.ordered ? `${block.start + i}.` : "•"}
              </Text>
              <View style={styles.itemBody}>
                {item.map((b, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no id.
                  <BlockView key={j} block={b} />
                ))}
              </View>
            </View>
          ))}
        </View>
      )
    case "table":
      return (
        <ScrollView horizontal style={[styles.table, { borderColor: palette.border }]}>
          <View>
            {[block.header, ...block.rows].map((row, r) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id.
                key={r}
                style={[
                  styles.tableRow,
                  {
                    borderColor: palette.border,
                    backgroundColor: r === 0 ? palette.surface : "transparent",
                  },
                ]}
              >
                {row.map((cell, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells have no id.
                  <View key={c} style={[styles.cell, { borderColor: palette.border }]}>
                    <Inlines list={cell} style={r === 0 ? { fontWeight: "600" } : undefined} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )
    case "rule":
      return <View style={[styles.rule, { backgroundColor: palette.border }]} />
  }
}

const Inlines = (props: {
  readonly list: readonly Inline[]
  readonly style?: object | undefined
  readonly heading?: boolean
}) => {
  const { palette } = useApp()
  // Images stand on their own line; the text around them stays one selectable Text.
  const groups: (Inline[] | Extract<Inline, { kind: "image" }>)[] = []
  for (const inline of props.list) {
    if (inline.kind === "image") groups.push(inline)
    else {
      const last = groups.at(-1)
      if (Array.isArray(last)) last.push(inline)
      else groups.push([inline])
    }
  }
  return (
    <>
      {groups.map((group, i) =>
        Array.isArray(group) ? (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: runs of text have no id.
            key={i}
            selectable
            accessibilityRole={props.heading ? "header" : undefined}
            style={[styles.body, { color: palette.text }, props.style]}
          >
            {group.map((inline, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs of text have no id.
              <InlineView key={j} inline={inline} />
            ))}
          </Text>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: images have no id.
          <MarkdownPicture key={i} picture={group.picture} />
        ),
      )}
    </>
  )
}

const InlineView = ({ inline }: { readonly inline: Inline }) => {
  const { palette } = useApp()
  switch (inline.kind) {
    case "break":
      return <Text>{"\n"}</Text>
    case "text":
      return (
        <Text
          style={{
            fontWeight: inline.style.bold ? "700" : undefined,
            fontStyle: inline.style.italic ? "italic" : undefined,
            textDecorationLine: inline.style.strike ? "line-through" : undefined,
            fontFamily: inline.style.code ? mono : undefined,
            backgroundColor: inline.style.code ? palette.surface : undefined,
          }}
        >
          {inline.text}
        </Text>
      )
    case "link":
      return (
        <Text
          accessibilityRole="link"
          style={{ color: palette.accent, textDecorationLine: "underline" }}
          onPress={() => void Linking.openURL(inline.href)}
        >
          {inline.children.map((child, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs of text have no id.
            <InlineView key={i} inline={child} />
          ))}
        </Text>
      )
    // An image in a run of text has no place for a box. The parser puts each image on its own line,
    // so this holds only the words of the image, and nothing loads.
    case "image":
      return (
        <Text>
          {inline.picture.kind === "inline" ? inline.picture.alt : inline.picture.box.alt}
        </Text>
      )
  }
}

/**
 * A picture of a reply (spec 003, "Pictures from the web"). A `data:image` picture shows at once.
 * An `https` picture is a box with the button "Load image", and the picture loads only after the
 * press. Another address is a box with no button.
 */
const MarkdownPicture = (props: { readonly picture: Picture }) => {
  const { picture } = props
  if (picture.kind === "inline") return <PictureImage src={picture.src} alt={picture.alt} />
  if (picture.kind === "ask") return <AskedPicture picture={picture} />
  return <PictureBoxView box={picture.box} />
}

const AskedPicture = (props: { readonly picture: Extract<Picture, { kind: "ask" }> }) => {
  const scope = useContext(PictureScope)
  const { picture } = props
  const loaded = usePictureLoaded(scope, picture.src)
  if (loaded) return <PictureImage src={picture.src} alt={picture.alt} />
  return <PictureBoxView box={picture.box} onLoad={() => loadPicture(scope, picture.src)} />
}

/** The box: the alt text, the address, and the button when the picture can load. */
const PictureBoxView = (props: { readonly box: PictureBox; readonly onLoad?: () => void }) => {
  const { t, palette } = useApp()
  const { box } = props
  return (
    <View
      testID="picture.box"
      style={[styles.pictureBox, { borderColor: palette.border, backgroundColor: palette.surface }]}
    >
      <Text
        testID="picture.alt"
        selectable
        style={{ color: palette.text, fontSize: text.s, lineHeight: 19 }}
      >
        {(box.alt || t("picture.alt.empty")) + (box.altCut ? "…" : "")}
      </Text>
      <Text
        testID="picture.address"
        selectable
        style={{ color: palette.textMuted, fontSize: text.xs, lineHeight: 17, fontFamily: mono }}
      >
        {box.address + (box.addressCut ? "…" : "")}
      </Text>
      {props.onLoad ? (
        <Button
          testID="picture.load"
          kind="secondary"
          label={t("picture.load")}
          onPress={props.onLoad}
          style={styles.pictureLoad}
        />
      ) : null}
    </View>
  )
}

/** A picture that shows. Its size is not known, so it fits a box. */
const PictureImage = (props: { readonly src: string; readonly alt: string }) => {
  const { palette } = useApp()
  const [ratio, setRatio] = useState(16 / 9)
  return (
    <Image
      testID="picture.image"
      source={{ uri: props.src }}
      accessibilityLabel={props.alt}
      resizeMode="contain"
      onLoad={(e) => {
        const { width, height } = e.nativeEvent.source
        if (width > 0 && height > 0) setRatio(width / height)
      }}
      style={[styles.image, { aspectRatio: ratio, backgroundColor: palette.surface }]}
    />
  )
}

const CodeBlock = (props: { readonly code: string }) => {
  const { t, palette } = useApp()
  const [copied, setCopied] = useState(false)
  return (
    <View style={[styles.code, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={copied ? t("common.copied") : t("common.copy")}
        hitSlop={8}
        style={styles.copy}
        onPress={() => {
          void Clipboard.setStringAsync(props.code).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        <Text style={{ color: palette.accent, fontSize: text.xs, fontWeight: "600" }}>
          {copied ? t("common.copied") : t("common.copy")}
        </Text>
      </Pressable>
      <ScrollView horizontal>
        <Text selectable style={[styles.codeText, { color: palette.text }]}>
          {props.code}
        </Text>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  blocks: { gap: space.s },
  body: { fontSize: text.m, lineHeight: 22 },
  quote: { borderLeftWidth: 3, paddingLeft: space.m, gap: space.s },
  list: { gap: space.xs },
  item: { flexDirection: "row", gap: space.s },
  itemBody: { flex: 1, gap: space.xs },
  table: { borderWidth: 1, borderRadius: radius.s },
  tableRow: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  cell: {
    minWidth: 80,
    maxWidth: 240,
    padding: space.s,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: space.s },
  image: { width: "100%", borderRadius: radius.m },
  pictureBox: { borderWidth: 1, borderRadius: radius.m, padding: space.m, gap: space.xs },
  pictureLoad: { alignSelf: "flex-start", marginTop: space.xs, minHeight: 44 },
  code: { borderWidth: 1, borderRadius: radius.m, padding: space.m, paddingTop: space.l + space.s },
  copy: { position: "absolute", top: space.s, right: space.m, zIndex: 1 },
  codeText: { fontFamily: mono, fontSize: text.s, lineHeight: 20 },
})
