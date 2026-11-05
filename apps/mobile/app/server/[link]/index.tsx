import { allPlaces, summarize } from "@robot/phone"
import type { Agent, Channel, Place, PlaceSection } from "@robot/shared"
import { router, Stack, useLocalSearchParams } from "expo-router"
import { useState } from "react"
import { PixelRatio, Pressable, StyleSheet, Text, View } from "react-native"
import { toggleSection } from "../../../src/prefs.ts"
import { useApp, useServer } from "../../../src/state/context.tsx"
import { radius, space, text } from "../../../src/theme/palette.ts"
import { ChannelMark } from "../../../src/ui/ChannelMark.tsx"
import { Face } from "../../../src/ui/Face.tsx"
import { Body, Button, HeaderButton, Notice, Screen } from "../../../src/ui/kit.tsx"
import { ShownText, useShownName } from "../../../src/ui/names.tsx"
import { stateText } from "../../../src/ui/states.ts"
import { WorkingDot } from "../../../src/ui/WorkingDot.tsx"

/**
 * Places (spec 011): the sections of the server, read only. The phone remembers which sections
 * the user closed; it cannot make, order or rename them.
 */
export default function Places() {
  const { link } = useLocalSearchParams<{ link: string }>()
  const { hub, t, prefs, setPrefs } = useApp()
  const view = useServer(link)
  if (!view) return <Screen>{null}</Screen>
  const { data, state } = view
  const closed = prefs.closed[link] ?? []
  const waiting = data.attention.filter(
    (n) => n.kind === "approval" || n.kind === "question",
  ).length

  return (
    <>
      <Stack.Screen
        options={{
          title: view.link.name,
          headerRight: () => (
            <HeaderButton
              testID="places.needsYou"
              label={
                waiting > 0 ? t("places.needsYou.count", { count: waiting }) : t("places.needsYou")
              }
              onPress={() => router.push({ pathname: "/server/[link]/needs", params: { link } })}
            />
          ),
        }}
      />
      <Screen testID="places" onRefresh={() => hub.refresh(link)}>
        {state === "not_allowed" ? (
          <>
            <Notice tone="danger" text={stateText(t, view)} />
            <Button label={t("servers.pairAgain")} onPress={() => router.push("/pair")} />
          </>
        ) : state === "online" ? null : data.places ? (
          <Notice text={state === "offline" ? t("places.offline") : stateText(t, view)} />
        ) : (
          <Notice
            text={
              state === "offline" || state === "update_app"
                ? `${stateText(t, view)} ${t("places.noCache", { name: view.link.name })}`
                : t("places.loading")
            }
          />
        )}
        <OrgChartRow linkId={link} serverName={view.link.name} />
        {(data.places ?? []).map((section) => (
          <Section
            key={section.id}
            linkId={link}
            section={section}
            agents={data.agents ?? []}
            channels={data.channels ?? []}
            closed={closed}
            toggle={(key) => setPrefs((p) => toggleSection(p, link, key))}
          />
        ))}
      </Screen>
    </>
  )
}

/** The way into the screen "Org chart" (spec 011, screen 8). It shows in every state of the link. */
const OrgChartRow = (props: { readonly linkId: string; readonly serverName: string }) => {
  const { t, palette } = useApp()
  return (
    <Pressable
      testID="places.orgChart"
      accessibilityRole="button"
      accessibilityLabel={t("places.orgChart")}
      accessibilityHint={t("places.orgChart.hint", { name: props.serverName })}
      onPress={() =>
        router.push({ pathname: "/server/[link]/org", params: { link: props.linkId } })
      }
      style={({ pressed }) => [
        styles.entry,
        {
          borderColor: palette.border,
          backgroundColor: pressed ? palette.pressed : palette.surface,
        },
      ]}
    >
      <Text style={[styles.entryText, { color: palette.text }]}>{t("places.orgChart")}</Text>
      <Text style={[styles.entryChevron, { color: palette.textMuted }]}>›</Text>
    </Pressable>
  )
}

const Section = (props: {
  readonly linkId: string
  readonly section: PlaceSection
  readonly agents: readonly Agent[]
  readonly channels: readonly Channel[]
  readonly closed: readonly string[]
  readonly toggle: (key: string) => void
}) => {
  const { t } = useApp()
  const { section } = props
  const everything = allPlaces(section)
  const open = !props.closed.includes(section.id)
  const title = section.id === "agents" ? t("places.agents") : t("places.channels")
  const row = (place: Place) => (
    <PlaceRow
      key={`${place.kind}:${place.id}`}
      linkId={props.linkId}
      place={place}
      agent={props.agents.find((a) => a.id === place.id)}
      channel={props.channels.find((c) => c.id === place.id)}
    />
  )
  return (
    <View style={styles.section}>
      <Header
        title={title}
        open={open}
        places={everything}
        onPress={() => props.toggle(section.id)}
        big
      />
      {open ? (
        <>
          {everything.length === 0 ? (
            <Body muted style={styles.empty}>
              {section.id === "agents" ? t("places.empty.agents") : t("places.empty.channels")}
            </Body>
          ) : null}
          {section.places.map(row)}
          {section.sections.map((user) => {
            const key = `user:${user.id}`
            const userOpen = !props.closed.includes(key)
            return (
              <View key={user.id} style={styles.userSection}>
                <Header
                  title={user.name}
                  open={userOpen}
                  places={user.places}
                  onPress={() => props.toggle(key)}
                />
                {userOpen ? (
                  user.places.length === 0 ? (
                    <Body muted style={styles.empty}>
                      {t("places.emptySection")}
                    </Body>
                  ) : (
                    user.places.map(row)
                  )
                ) : null}
              </View>
            )
          })}
        </>
      ) : null}
    </View>
  )
}

/** A section header. When closed, it shows the unread sum and a working dot (as on desktop). */
const Header = (props: {
  readonly title: string
  readonly open: boolean
  readonly places: readonly Place[]
  readonly onPress: () => void
  readonly big?: boolean
}) => {
  const { t, palette } = useApp()
  const sum = summarize(props.places)
  return (
    <Pressable
      testID={`section.${props.title}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: props.open }}
      accessibilityLabel={t(props.open ? "places.section.open" : "places.section.closed", {
        name: props.title,
      })}
      onPress={props.onPress}
      style={({ pressed }) => [styles.header, { opacity: pressed ? 0.6 : 1 }]}
    >
      <Text style={[styles.chevron, { color: palette.textMuted }]}>{props.open ? "▾" : "▸"}</Text>
      <Text
        style={[
          props.big ? styles.headerBig : styles.headerSmall,
          { color: props.big ? palette.text : palette.textMuted },
        ]}
        numberOfLines={1}
      >
        {props.title}
      </Text>
      {!props.open && sum.working ? <WorkingDot /> : null}
      {!props.open && sum.unread > 0 ? <Badge count={sum.unread} /> : null}
    </Pressable>
  )
}

const Badge = ({ count }: { readonly count: number }) => {
  const { t, palette } = useApp()
  return (
    <View
      style={[styles.badge, { backgroundColor: palette.accent }]}
      accessibilityLabel={t("places.unread", { count })}
    >
      <Text style={[styles.badgeText, { color: palette.accentText }]}>
        {count > 99 ? "99+" : count}
      </Text>
    </View>
  )
}

const PlaceRow = (props: {
  readonly linkId: string
  readonly place: Place
  readonly agent: Agent | undefined
  readonly channel: Channel | undefined
}) => {
  const { t, palette } = useApp()
  const { place } = props
  // An agent shows its organization prefix before the name (spec 035). The accessible name adds
  // the whole organization name. A channel has none.
  const shownName = useShownName(props.linkId)
  const shown =
    place.kind === "agent"
      ? shownName(place.id, place.name)
      : { prefix: null, organization: null, name: place.name, text: place.name, label: place.name }
  // The role line of an agent shows as a badge after the name (spec 001, 011). A channel has none,
  // and a computer that does not send it yet gives no badge.
  const role = place.kind === "agent" ? place.role?.trim() : undefined
  const [slot, setSlot] = useState(0)
  const details = [
    role ? t("places.role", { role }) : null,
    place.working ? t("places.working") : null,
    place.unread > 0 ? t("places.unread", { count: place.unread }) : null,
    place.lastMessage,
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <Pressable
      testID={`place.${place.name}`}
      accessibilityRole="button"
      accessibilityLabel={t("places.row", { name: shown.label, details })}
      onPress={() =>
        router.push({
          pathname: "/server/[link]/[kind]/[id]",
          params: { link: props.linkId, kind: place.kind, id: place.id },
        })
      }
      style={({ pressed }) => [
        styles.place,
        { backgroundColor: pressed ? palette.pressed : "transparent" },
      ]}
    >
      {place.kind === "agent" ? (
        <Face face={props.agent?.face} image={props.agent?.faceImage} size={36} />
      ) : (
        <ChannelMark picture={props.channel?.picture} size={36} />
      )}
      <View style={styles.placeText}>
        <View style={styles.placeTop}>
          <ShownText
            shown={shown}
            numberOfLines={1}
            style={[
              styles.placeName,
              { color: palette.text, fontWeight: place.unread > 0 ? "700" : "500" },
            ]}
          />
          {place.working ? <WorkingDot /> : null}
          {role ? (
            // The name comes first. The slot is what is left of the line. The badge is cut with an
            // ellipsis in it, and it hides when less than 4 characters of it fit.
            <View
              style={styles.roleSlot}
              onLayout={(event) => setSlot(event.nativeEvent.layout.width)}
            >
              {slot >= roleBadgeMin() ? (
                <Text
                  testID={`role.${place.name}`}
                  numberOfLines={1}
                  style={[
                    styles.roleBadge,
                    { color: palette.textMuted, borderColor: palette.border },
                  ]}
                >
                  {role}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
        {place.lastMessage ? (
          <Text numberOfLines={1} style={[styles.last, { color: palette.textMuted }]}>
            {place.lastMessage}
          </Text>
        ) : null}
      </View>
      {place.unread > 0 ? <Badge count={place.unread} /> : null}
    </Pressable>
  )
}

/** Room for 4 characters of the badge, its padding and its border, at the text size of the user. */
const roleBadgeMin = () => Math.ceil(4 * text.xs * 0.62 * PixelRatio.getFontScale()) + 14

const styles = StyleSheet.create({
  entry: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: space.m,
    borderWidth: 1,
    borderRadius: radius.l,
  },
  entryText: { fontSize: text.m, fontWeight: "600" },
  entryChevron: { fontSize: text.xl },
  section: { gap: space.xs },
  userSection: { gap: space.xs, marginLeft: space.s },
  empty: { fontSize: text.s, paddingHorizontal: space.s, paddingVertical: space.xs },
  header: { flexDirection: "row", alignItems: "center", gap: space.s, minHeight: 44 },
  chevron: { width: 14, fontSize: text.s },
  headerBig: { flex: 1, fontSize: text.l, fontWeight: "700" },
  headerSmall: { flex: 1, fontSize: text.s, fontWeight: "600" },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: radius.round,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: text.xs, fontWeight: "700" },
  place: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.m,
    minHeight: 56,
    paddingHorizontal: space.s,
    borderRadius: radius.m,
  },
  placeText: { flex: 1, gap: 2 },
  placeTop: { flexDirection: "row", alignItems: "center", gap: space.s },
  placeName: { fontSize: text.m, flexShrink: 1 },
  roleSlot: { flex: 1, minWidth: 0, flexDirection: "row" },
  roleBadge: {
    flexShrink: 1,
    fontSize: text.xs,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderRadius: radius.s,
    overflow: "hidden",
  },
  last: { fontSize: text.s },
})
