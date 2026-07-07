import { randomBytes } from 'node:crypto'
import { CHIP_SCALE, formatUsd } from '../config.js'
import { openWallet, type Wallet } from '../payments/wallet.js'
import { HttpError, type Payout } from './table.js'

/**
 * Spectator betting book: humans back an agent to win the match with real
 * testnet pathUSD. Stakes move spectator → treasury when placed; winners are
 * paid `stake × multiplier` from the treasury at settlement.
 *
 * Spectator wallets are server-custodial (keys in `.wallets/spectators/`,
 * gitignored, testnet only) so the browser needs no wallet extension.
 */

export type SpectatorBet = {
  id: string
  spectatorId: string
  agentId: string
  /** Stake in chips (pathUSD base units). */
  amount: number
  /** Payout multiplier locked at bet time (= seats in the match). */
  multiplier: number
  status: 'open' | 'won' | 'lost' | 'refunded'
  txHash?: string
  payoutTx?: string
}

export const TOPUP_CHIPS = 100 * CHIP_SCALE
const MIN_BET_CHIPS = 1 * CHIP_SCALE
const MAX_BET_CHIPS = 100 * CHIP_SCALE
const SPECTATOR_ID_RE = /^[a-f0-9]{16,64}$/

type EmitFn = (type: string, data: Record<string, unknown>) => void

export class BettingBook {
  private readonly treasury: Wallet
  private readonly emit: EmitFn
  private wallets = new Map<string, Wallet>()
  private bets: SpectatorBet[] = []
  private resolving = false

  constructor(treasury: Wallet, emit: EmitFn) {
    this.treasury = treasury
    this.emit = emit
  }

  /** Reopens (or creates) a spectator session; wallets start empty. */
  async session(spectatorId?: string): Promise<{ spectatorId: string; balance: number }> {
    const id = spectatorId && SPECTATOR_ID_RE.test(spectatorId) ? spectatorId : randomBytes(16).toString('hex')
    const wallet = await this.wallet(id)
    return { spectatorId: id, balance: Number(await wallet.balance()) }
  }

  /** Treasury sends a fixed testnet top-up to the spectator wallet. */
  async topup(spectatorId: string): Promise<{ balance: number }> {
    const wallet = await this.wallet(this.validId(spectatorId))
    await this.treasury.send(wallet.address, BigInt(TOPUP_CHIPS))
    return { balance: Number(await wallet.balance()) }
  }

  async place(
    spectatorId: string,
    agentId: string,
    amountChips: number,
    context: { seatedIds: string[]; open: boolean; multiplier: number },
  ): Promise<SpectatorBet> {
    const id = this.validId(spectatorId)
    if (!context.open) throw new HttpError(409, 'Betting is closed for this match')
    if (!context.seatedIds.includes(agentId)) throw new HttpError(400, 'Unknown player')
    if (!Number.isInteger(amountChips) || amountChips < MIN_BET_CHIPS || amountChips > MAX_BET_CHIPS) {
      throw new HttpError(400, `Bet must be between ${formatUsd(MIN_BET_CHIPS)} and ${formatUsd(MAX_BET_CHIPS)}`)
    }
    const wallet = await this.wallet(id)
    if ((await wallet.balance()) < BigInt(amountChips)) throw new HttpError(402, 'Not enough balance — top up first')

    const txHash = await wallet.send(this.treasury.address, BigInt(amountChips))
    const bet: SpectatorBet = {
      id: randomBytes(8).toString('hex'),
      spectatorId: id,
      agentId,
      amount: amountChips,
      multiplier: context.multiplier,
      status: 'open',
      txHash,
    }
    this.bets.push(bet)
    if (this.bets.length > 5000) this.bets.shift()
    this.emit('bet_placed', { agentId, amount: formatUsd(amountChips) })
    return bet
  }

  /** Public pools + the caller's bets (never other spectators' identities). */
  state(spectatorId?: string): { pools: Record<string, number>; myBets: SpectatorBet[] } {
    const pools: Record<string, number> = {}
    for (const bet of this.bets) {
      if (bet.status !== 'open') continue
      pools[bet.agentId] = (pools[bet.agentId] ?? 0) + bet.amount
    }
    const myBets =
      spectatorId && SPECTATOR_ID_RE.test(spectatorId)
        ? this.bets.filter((b) => b.spectatorId === spectatorId).slice(-10)
        : []
    return { pools, myBets }
  }

  /** Settles open bets against the match result. Ties refund everyone. */
  async resolve(payouts: Payout[]): Promise<void> {
    if (this.resolving) return
    this.resolving = true
    try {
      const open = this.bets.filter((b) => b.status === 'open')
      if (!open.length || !payouts.length) return
      const top = Math.max(...payouts.map((p) => p.chips))
      const winners = payouts.filter((p) => p.chips === top).map((p) => p.playerId)
      if (winners.length !== 1) {
        await this.refundOpen('tie')
        return
      }
      const winnerId = winners[0]!
      for (const bet of open) {
        if (bet.agentId === winnerId) {
          const wallet = await this.wallet(bet.spectatorId)
          const prize = bet.amount * bet.multiplier
          bet.payoutTx = await this.treasury.send(wallet.address, BigInt(prize))
          bet.status = 'won'
          this.emit('bet_won', { agentId: bet.agentId, amount: formatUsd(prize) })
        } else {
          bet.status = 'lost'
        }
      }
    } catch (error) {
      console.error('[bets] resolve failed', error)
    } finally {
      this.resolving = false
    }
  }

  /** Returns open stakes (e.g. when a match is reset before finishing). */
  async refundOpen(reason: string): Promise<void> {
    const open = this.bets.filter((b) => b.status === 'open')
    for (const bet of open) {
      try {
        const wallet = await this.wallet(bet.spectatorId)
        bet.payoutTx = await this.treasury.send(wallet.address, BigInt(bet.amount))
        bet.status = 'refunded'
      } catch (error) {
        console.error('[bets] refund failed', error)
      }
    }
    if (open.length) this.emit('bets_refunded', { count: open.length, reason })
  }

  async balance(spectatorId: string): Promise<number> {
    const wallet = await this.wallet(this.validId(spectatorId))
    return Number(await wallet.balance())
  }

  private validId(spectatorId: string): string {
    if (!SPECTATOR_ID_RE.test(spectatorId)) throw new HttpError(400, 'Invalid spectator id')
    return spectatorId
  }

  private async wallet(id: string): Promise<Wallet> {
    let wallet = this.wallets.get(id)
    if (!wallet) {
      wallet = await openWallet(`spectator-${id.slice(0, 8)}`, `.wallets/spectators/${id}.json`, { autofund: false })
      this.wallets.set(id, wallet)
    }
    return wallet
  }
}
