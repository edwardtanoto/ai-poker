import { describe, expect, test } from 'vitest'
import { parseCards } from './cards.js'
import { evaluate } from './evaluator.js'
import { Hand } from './hand.js'

describe('evaluator', () => {
  const rank = (s: string) => evaluate(parseCards(s))

  test('hand categories in order', () => {
    const hands = [
      { s: '2c 5d 9h Jc Ks', name: 'High Card' },
      { s: '2c 2d 9h Jc Ks', name: 'Pair' },
      { s: '2c 2d 9h 9c Ks', name: 'Two Pair' },
      { s: '2c 2d 2h Jc Ks', name: 'Three of a Kind' },
      { s: '3c 4d 5h 6c 7s', name: 'Straight' },
      { s: '2c 5c 9c Jc Kc', name: 'Flush' },
      { s: '2c 2d 2h Kc Ks', name: 'Full House' },
      { s: '2c 2d 2h 2s Ks', name: 'Four of a Kind' },
      { s: '3c 4c 5c 6c 7c', name: 'Straight Flush' },
    ]
    for (let i = 0; i < hands.length; i++) {
      expect(rank(hands[i]!.s).name).toBe(hands[i]!.name)
      if (i > 0) expect(rank(hands[i]!.s).value).toBeGreaterThan(rank(hands[i - 1]!.s).value)
    }
  })

  test('wheel straight (A-5) beats nothing higher', () => {
    const wheel = rank('Ac 2d 3h 4c 5s')
    const sixHigh = rank('2c 3d 4h 5c 6s')
    expect(wheel.name).toBe('Straight')
    expect(sixHigh.value).toBeGreaterThan(wheel.value)
  })

  test('ace-high straight is best straight', () => {
    expect(rank('Tc Jd Qh Kc As').value).toBeGreaterThan(rank('9c Td Jh Qc Ks').value)
  })

  test('kickers break ties', () => {
    expect(rank('Ac Ad 9h 8c 2s').value).toBeGreaterThan(rank('Ah As 9d 7c 2d').value)
  })

  test('7-card picks best 5', () => {
    // Board pairs + hole flush
    const score = evaluate(parseCards('Ah Kh Qh Jh Th 2c 2d'))
    expect(score.name).toBe('Straight Flush')
  })

  test('same two pair, kicker plays from 7', () => {
    const a = evaluate(parseCards('Ac Ad Kc Kd Qh 3s 2s'))
    const b = evaluate(parseCards('Ah As Kh Ks Jh 3d 2d'))
    expect(a.value).toBeGreaterThan(b.value)
  })
})

/** Deterministic RNG for reproducible deals. */
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32
    return s / 2 ** 32
  }
}

const CONFIG = { smallBlind: 5, bigBlind: 10 }

describe('hand flow', () => {
  test('fold preflop awards blinds without showdown', () => {
    const hand = new Hand([{ id: 'a', stack: 100 }, { id: 'b', stack: 100 }], 0, 1, {
      ...CONFIG, random: seeded(42),
    })
    // Heads-up: dealer (a) is SB, acts first preflop
    expect(hand.currentPlayerId).toBe('a')
    hand.act('a', { type: 'fold' })
    expect(hand.isComplete).toBe(true)
    expect(hand.result!.winners).toEqual([{ playerId: 'b', amount: 15 }])
    const a = hand.players.find((p) => p.id === 'a')!
    const b = hand.players.find((p) => p.id === 'b')!
    expect(a.stack).toBe(95)
    expect(b.stack).toBe(105)
  })

  test('check-down to showdown conserves chips', () => {
    const hand = new Hand([{ id: 'a', stack: 100 }, { id: 'b', stack: 100 }], 0, 1, {
      ...CONFIG, random: seeded(7),
    })
    hand.act('a', { type: 'call' })
    hand.act('b', { type: 'check' })
    for (const street of ['flop', 'turn', 'river']) {
      expect(hand.street).toBe(street)
      // Postflop heads-up: BB (non-dealer, b) acts first
      hand.act('b', { type: 'check' })
      hand.act('a', { type: 'check' })
    }
    expect(hand.isComplete).toBe(true)
    expect(hand.result!.showdown).toBe(true)
    const total = hand.players.reduce((s, p) => s + p.stack, 0)
    expect(total).toBe(200)
  })

  test('raise and re-raise sizing enforced', () => {
    const hand = new Hand([{ id: 'a', stack: 500 }, { id: 'b', stack: 500 }], 0, 1, {
      ...CONFIG, random: seeded(3),
    })
    hand.act('a', { type: 'raise', amount: 30 }) // raise to 30 (raise size 20)
    const legal = hand.legalActions()!
    expect(legal.playerId).toBe('b')
    expect(legal.callAmount).toBe(20)
    expect(legal.minRaiseTo).toBe(50) // 30 + 20
    hand.act('b', { type: 'raise', amount: 50 })
    hand.act('a', { type: 'call' })
    expect(hand.street).toBe('flop')
    expect(hand.pot).toBe(100)
  })

  test('all-in for less than call does not reopen action', () => {
    const hand = new Hand(
      [{ id: 'a', stack: 500 }, { id: 'b', stack: 25 }],
      0, 1, { ...CONFIG, random: seeded(9) },
    )
    hand.act('a', { type: 'raise', amount: 60 })
    hand.act('b', { type: 'allin' }) // 25 total < 60
    // b all-in below current bet — hand should run out to showdown
    expect(hand.isComplete).toBe(true)
    const total = hand.players.reduce((s, p) => s + p.stack, 0)
    expect(total).toBe(525)
  })

  test('side pots: short stack all-in wins main pot only', () => {
    // 3 players; c is short. Use many seeds to find one where short stack wins
    // — instead, verify pot math invariant: total chips conserved and the
    // short stack can never win more than 3x their commitment.
    for (let seed = 1; seed <= 30; seed++) {
      const hand = new Hand(
        [{ id: 'a', stack: 300 }, { id: 'b', stack: 300 }, { id: 'c', stack: 50 }],
        0, 1, { ...CONFIG, random: seeded(seed) },
      )
      // dealer a; sb=b, bb=c; first to act = a
      hand.act('a', { type: 'allin' })
      hand.act('b', { type: 'allin' })
      hand.act('c', { type: 'allin' })
      expect(hand.isComplete).toBe(true)
      const total = hand.players.reduce((s, p) => s + p.stack, 0)
      expect(total).toBe(650)
      const c = hand.players.find((p) => p.id === 'c')!
      expect(c.stack).toBeLessThanOrEqual(150) // main pot cap: 3 x 50
    }
  })

  test('both all-in from blinds runs out board', () => {
    const hand = new Hand([{ id: 'a', stack: 5 }, { id: 'b', stack: 10 }], 0, 1, {
      ...CONFIG, random: seeded(11),
    })
    expect(hand.isComplete).toBe(true)
    const total = hand.players.reduce((s, p) => s + p.stack, 0)
    expect(total).toBe(15)
  })

  test('fuzz: random legal actions always conserve chips and terminate', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = seeded(seed * 977)
      const stacks = [
        { id: 'p1', stack: 100 + Math.floor(rng() * 400) },
        { id: 'p2', stack: 100 + Math.floor(rng() * 400) },
        { id: 'p3', stack: 20 + Math.floor(rng() * 100) },
      ]
      const totalBefore = stacks.reduce((s, p) => s + p.stack, 0)
      const hand = new Hand(stacks, seed % 3, 1, { ...CONFIG, random: rng })
      let guard = 0
      while (!hand.isComplete) {
        if (++guard > 200) throw new Error(`seed ${seed}: hand did not terminate`)
        const legal = hand.legalActions()!
        const roll = rng()
        if (legal.canCheck && roll < 0.5) hand.act(legal.playerId, { type: 'check' })
        else if (legal.canCall && roll < 0.55) hand.act(legal.playerId, { type: 'call' })
        else if (legal.canRaise && roll < 0.7) {
          hand.act(legal.playerId, {
            type: 'raise',
            amount: legal.minRaiseTo + Math.floor(rng() * 20),
          })
        } else if (legal.canFold) hand.act(legal.playerId, { type: 'fold' })
        else if (legal.canCheck) hand.act(legal.playerId, { type: 'check' })
        else hand.act(legal.playerId, { type: 'call' })
      }
      const totalAfter = hand.players.reduce((s, p) => s + p.stack, 0)
      expect(totalAfter).toBe(totalBefore)
      // Winners recorded
      expect(hand.result!.winners.length).toBeGreaterThan(0)
    }
  })
})
