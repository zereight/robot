import type { ModelInfo } from "./providers.ts"

/**
 * The order of the models in the picker, and which models are older (spec 006, "Model list").
 *
 * The order comes from the dates or the versions that the provider gives. A date is the time the
 * provider says it made the model. A version is the numbers in the id of the model: `5.1` in
 * `gpt-5.1`, or `4-5` in `claude-opus-4-5`. When the provider gives neither, the list keeps its
 * order and no model is older.
 */

/** Words that name no version of a family. `latest` follows the newest model of the family. */
const LOOSE_WORDS = new Set(["latest"])

interface Placed {
  readonly model: ModelInfo
  /** The id without its numbers: models of one family share it. */
  readonly family: string
  /** The numbers of the id, in order. Empty when the id has none. */
  readonly version: readonly number[]
  /** A date in the id, as `20251101`. It tells two snapshots of one version apart. */
  readonly stamp: number | undefined
}

const place = (model: ModelInfo): Placed => {
  const words: string[] = []
  const version: number[] = []
  let stamp: number | undefined
  for (const part of model.id.toLowerCase().split(/[-_.:/\s]+/)) {
    if (part === "") continue
    if (/^(?:19|20)\d{6}$/.test(part)) stamp = Number(part)
    else if (/^\d+$/.test(part)) version.push(Number(part))
    else if (!LOOSE_WORDS.has(part)) words.push(part)
  }
  return { model, family: words.join("-"), version, stamp }
}

/** Negative when `a` is the older version, positive when it is the newer one, else 0. */
const compareVersions = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x - y
  }
  return 0
}

/** True when `a` is newer than `b`, by their dates, or else by their versions. */
const newerThan = (a: Placed, b: Placed): boolean => {
  if (a.model.created !== undefined && b.model.created !== undefined)
    return a.model.created > b.model.created
  if (a.version.length > 0 && b.version.length > 0) {
    const gap = compareVersions(a.version, b.version)
    if (gap !== 0) return gap > 0
    return a.stamp !== undefined && b.stamp !== undefined && a.stamp > b.stamp
  }
  return false
}

/**
 * The models with the newest first. A model is `older` when the list also holds a newer model of
 * the same family.
 *
 * With dates, the whole list goes newest first, and a model with no date goes after the others, in
 * the order of the provider. Without dates the list keeps the order of the provider, because the
 * numbers in ids say nothing about the age of models of different makers; only the models of one
 * family change places among themselves, newest version first.
 */
export const orderModels = (models: readonly ModelInfo[]): ModelInfo[] => {
  const placed = models.map(place)
  const dated = placed.some((p) => p.model.created !== undefined)
  const sorted: Placed[] = dated
    ? placed
        .map((p, index) => ({ p, index }))
        .sort((x, y) => {
          const a = x.p.model.created
          const b = y.p.model.created
          if (a === undefined || b === undefined) {
            if (a === b) return x.index - y.index
            return a === undefined ? 1 : -1
          }
          return b - a !== 0 ? b - a : x.index - y.index
        })
        .map((entry) => entry.p)
    : sortFamilies(placed)
  return sorted.map((p) => {
    const older =
      p.family !== "" && placed.some((o) => o !== p && o.family === p.family && newerThan(o, p))
    return older ? { ...p.model, older: true as const } : p.model
  })
}

/** Keeps the places of the list, and puts the models of each family in order, newest first. */
const sortFamilies = (placed: readonly Placed[]): Placed[] => {
  const out = [...placed]
  const families = new Map<string, number[]>()
  placed.forEach((p, index) => {
    if (p.family === "" || p.version.length === 0) return
    families.set(p.family, [...(families.get(p.family) ?? []), index])
  })
  for (const slots of families.values()) {
    if (slots.length < 2) continue
    const members = slots
      .map((slot) => placed[slot] as Placed)
      .map((p, rank) => ({ p, rank }))
      .sort((x, y) => {
        const gap = compareVersions(y.p.version, x.p.version)
        if (gap !== 0) return gap
        const stamp = (y.p.stamp ?? 0) - (x.p.stamp ?? 0)
        return stamp !== 0 ? stamp : x.rank - y.rank
      })
    slots.forEach((slot, i) => {
      out[slot] = (members[i] as { p: Placed }).p
    })
  }
  return out
}

/** True when a model matches the words typed in the search box of the picker. */
export const modelMatches = (model: ModelInfo, label: string, query: string): boolean => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = `${label} ${model.id}`.toLowerCase()
  return words.every((w) => text.includes(w))
}
