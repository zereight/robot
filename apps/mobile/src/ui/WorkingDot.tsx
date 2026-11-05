import { useEffect, useSyncExternalStore } from "react"
import { AccessibilityInfo, Animated, Easing, StyleSheet, View } from "react-native"
import { useApp } from "../state/context.tsx"

/**
 * The working dot of a place (spec 001, "Place rows"; 011). It breathes while the work runs: the
 * dot is a success colour and it grows and fades, and comes back, in 1.4 s, without end. That is
 * one of the two motions that do not end (000), next to the light of the badge in the chat. With
 * reduce motion, the dot is still.
 *
 * The dot of a place sits on the face of the place, and it has a thin soft ring of its own colour
 * around a gap of the surface. The dot of a collapsed header sits beside the name and has no ring,
 * as on the desktop. The whole mark grows and fades together, so the ring breathes with the dot.
 */

/** One breath, as the light of the badge takes it (spec 000). */
const BREATH_MS = 1400
const DIM = 0.55
const BRIGHT = 1
const SMALL = 0.8
/** The dot, the gap around it, and the thin ring: 4 + 2 + 2 px on each side. */
const DOT = 8
const GAP = 2
const RING = 2
const MARK = DOT + (GAP + RING) * 2
/** The soft ring of a place dot is the dot colour at this share, as on the desktop. */
const RING_ALPHA = 0.3

/**
 * The setting "Reduce Motion" of the phone. The app reads it once, and each change of it is heard.
 * A view reads it through `useSyncExternalStore`, so the whole list follows one change of it.
 */
let reduced = false
let watching = false
const watchers = new Set<() => void>()

function publishReducedMotion(on: boolean) {
  if (reduced === on) return
  reduced = on
  for (const tell of watchers) tell()
}

function watchReducedMotion() {
  if (watching) return
  watching = true
  void AccessibilityInfo.isReduceMotionEnabled()
    .then(publishReducedMotion)
    .catch(() => {})
  AccessibilityInfo.addEventListener("reduceMotionChanged", publishReducedMotion)
}

function subscribeReducedMotion(tell: () => void) {
  watchers.add(tell)
  return () => {
    watchers.delete(tell)
  }
}

function useReducedMotion() {
  watchReducedMotion()
  return useSyncExternalStore(subscribeReducedMotion, () => reduced)
}

/**
 * One breath for every dot of the list, so two places that work breathe together and not against
 * each other. It runs while at least one dot shows, and it stops with the last one.
 */
const breath = new Animated.Value(BRIGHT)
let loop: Animated.CompositeAnimation | null = null
let showing = 0

function startBreath() {
  showing += 1
  if (showing > 1) return
  breath.setValue(DIM)
  const half = BREATH_MS / 2
  const step = (toValue: number) =>
    Animated.timing(breath, {
      toValue,
      duration: half,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    })
  loop = Animated.loop(Animated.sequence([step(BRIGHT), step(DIM)]))
  loop.start()
}

function stopBreath() {
  showing -= 1
  if (showing > 0) return
  loop?.stop()
  loop = null
  breath.setValue(BRIGHT)
}

/** The colour of the dot with an alpha, for the soft ring around it. */
function withAlpha(colour: string, alpha: number) {
  const hex = colour.startsWith("#") ? colour.slice(1) : ""
  if (hex.length !== 6) return colour
  const value = Number.parseInt(hex, 16)
  if (Number.isNaN(value)) return colour
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * The dot of a place that works, or of a collapsed header. It shows only while the work runs; the
 * caller decides that. `ring` is set on the dot that sits on a face.
 */
export const WorkingDot = (props: { readonly ring?: boolean }) => {
  const { palette } = useApp()
  const still = useReducedMotion()

  // A dot that is not still joins the shared breath of the list, and leaves it when it goes. With
  // reduce motion the dot is still, and it does not join.
  useEffect(() => {
    if (still) return undefined
    startBreath()
    return () => stopBreath()
  }, [still])

  if (!props.ring) {
    return (
      <Animated.View
        testID="working-dot"
        style={{
          width: DOT,
          height: DOT,
          borderRadius: DOT / 2,
          backgroundColor: palette.success,
          opacity: still ? BRIGHT : breath,
          transform: [{ scale: still ? BRIGHT : growOf(breath) }],
        }}
      />
    )
  }

  // The ring is the dot colour at a low alpha around a gap of the surface, as on the desktop. The
  // whole mark is one view, so the breath scales and fades the ring with the dot.
  return (
    <Animated.View
      testID="working-dot"
      style={[
        ringStyles.mark,
        {
          width: MARK,
          height: MARK,
          borderRadius: MARK / 2,
          backgroundColor: withAlpha(palette.success, RING_ALPHA),
          opacity: still ? BRIGHT : breath,
          transform: [{ scale: still ? BRIGHT : growOf(breath) }],
        },
      ]}
    >
      <View
        style={{
          width: DOT + GAP * 2,
          height: DOT + GAP * 2,
          borderRadius: (DOT + GAP * 2) / 2,
          backgroundColor: palette.background,
        }}
      >
        <View
          style={{
            width: DOT,
            height: DOT,
            borderRadius: DOT / 2,
            backgroundColor: palette.success,
          }}
        />
      </View>
    </Animated.View>
  )
}

const growOf = (value: Animated.Value) =>
  value.interpolate({ inputRange: [DIM, BRIGHT], outputRange: [SMALL, BRIGHT] })

const ringStyles = StyleSheet.create({
  mark: { alignItems: "center", justifyContent: "center" },
})
