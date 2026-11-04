import { useEffect, useSyncExternalStore } from "react"
import { AccessibilityInfo, Animated, Easing } from "react-native"
import { useApp } from "../state/context.tsx"

/**
 * The working dot of a place and of a collapsed header (spec 001, "Place rows"; 011). It breathes
 * while the work runs: the dot grows and fades, and comes back, in 1.4 s, without end. That is one
 * of the two motions that do not end (000), next to the light of the badge in the chat. With reduce
 * motion, the dot is still.
 */

/** One breath, as the light of the badge takes it (spec 000). */
const BREATH_MS = 1400
const DIM = 0.55
const BRIGHT = 1
const SMALL = 0.8
const DOT = 8

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

/** The dot of a place that works. It shows only while the work runs; the caller decides that. */
export const WorkingDot = () => {
  const { palette } = useApp()
  const still = useReducedMotion()

  // A dot that is not still joins the shared breath of the list, and leaves it when it goes. With
  // reduce motion the dot is still, and it does not join.
  useEffect(() => {
    if (still) return undefined
    startBreath()
    return () => stopBreath()
  }, [still])

  // The dot grows and fades together, as the light of the badge does (spec 000).
  const grow = breath.interpolate({ inputRange: [DIM, BRIGHT], outputRange: [SMALL, BRIGHT] })
  return (
    <Animated.View
      testID="working-dot"
      style={{
        width: DOT,
        height: DOT,
        borderRadius: DOT / 2,
        backgroundColor: palette.success,
        opacity: still ? BRIGHT : breath,
        transform: [{ scale: still ? BRIGHT : grow }],
      }}
    />
  )
}
