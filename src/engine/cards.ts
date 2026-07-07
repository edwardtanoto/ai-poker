import type { Card, Rank, Suit } from './types.js'

export const SUITS: Suit[] = ['c', 'd', 'h', 's']
export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]

const RANK_CHARS: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
}

export function createDeck(): Card[] {
  const deck: Card[] = []
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit })
  return deck
}

export function shuffle(deck: Card[], random: () => number = Math.random): Card[] {
  const cards = [...deck]
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[cards[i], cards[j]] = [cards[j]!, cards[i]!]
  }
  return cards
}

export function cardToString(card: Card): string {
  return `${RANK_CHARS[card.rank]}${card.suit}`
}

export function cardsToString(cards: Card[]): string {
  return cards.map(cardToString).join(' ')
}

export function parseCard(str: string): Card {
  const rankChar = str[0]!.toUpperCase()
  const suit = str[1]!.toLowerCase() as Suit
  const rank = (Object.entries(RANK_CHARS).find(([, c]) => c === rankChar)?.[0])
  if (!rank || !SUITS.includes(suit)) throw new Error(`Invalid card: ${str}`)
  return { rank: Number(rank) as Rank, suit }
}

export function parseCards(str: string): Card[] {
  return str.trim().split(/\s+/).map(parseCard)
}
