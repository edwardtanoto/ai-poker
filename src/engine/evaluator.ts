import type { Card, Rank } from './types.js'

/**
 * Hand categories, higher is better:
 * 8 straight flush, 7 quads, 6 full house, 5 flush, 4 straight,
 * 3 trips, 2 two pair, 1 pair, 0 high card
 */
const HAND_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
] as const

export type HandScore = {
  /** Comparable numeric score — higher wins. */
  value: number
  name: (typeof HAND_NAMES)[number]
}

/** Packs category + up to five tiebreak ranks (4 bits each) into one number. */
function pack(category: number, ranks: number[]): number {
  let v = category
  for (let i = 0; i < 5; i++) v = v * 16 + (ranks[i] ?? 0)
  return v
}

/** Evaluates exactly 5 cards. */
function evaluate5(cards: Card[]): number {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a)
  const isFlush = cards.every((c) => c.suit === cards[0]!.suit)

  // Straight detection (with wheel A-5)
  const unique = [...new Set(ranks)]
  let straightHigh = 0
  if (unique.length === 5) {
    if (unique[0]! - unique[4]! === 4) straightHigh = unique[0]!
    else if (unique[0] === 14 && unique[1] === 5 && unique[4] === 2) straightHigh = 5 // wheel
  }

  const counts = new Map<Rank, number>()
  for (const r of ranks) counts.set(r as Rank, (counts.get(r as Rank) ?? 0) + 1)
  // Sort by count desc, then rank desc → tiebreak order
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])
  const ordered = groups.flatMap(([rank, count]) => Array(count).fill(rank) as number[])

  if (isFlush && straightHigh) return pack(8, [straightHigh])
  if (groups[0]![1] === 4) return pack(7, ordered)
  if (groups[0]![1] === 3 && groups[1]?.[1] === 2) return pack(6, ordered)
  if (isFlush) return pack(5, ranks)
  if (straightHigh) return pack(4, [straightHigh])
  if (groups[0]![1] === 3) return pack(3, ordered)
  if (groups[0]![1] === 2 && groups[1]?.[1] === 2) return pack(2, ordered)
  if (groups[0]![1] === 2) return pack(1, ordered)
  return pack(0, ranks)
}

/** Best 5-card hand from 5-7 cards. */
export function evaluate(cards: Card[]): HandScore {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate() needs 5-7 cards, got ${cards.length}`)
  }
  let best = -1
  const n = cards.length
  if (n === 5) {
    best = evaluate5(cards)
  } else {
    // All 5-card combinations
    const combo = (start: number, chosen: Card[]) => {
      if (chosen.length === 5) {
        const v = evaluate5(chosen)
        if (v > best) best = v
        return
      }
      for (let i = start; i <= n - (5 - chosen.length); i++) {
        combo(i + 1, [...chosen, cards[i]!])
      }
    }
    combo(0, [])
  }
  const category = Math.floor(best / 16 ** 5)
  return { value: best, name: HAND_NAMES[category]! }
}
