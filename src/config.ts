/** Shared configuration for the x402-poker table, agents, and payments. */
import { existsSync, readFileSync } from 'node:fs'

// Minimal .env loader (no dependency): real env vars always win.
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]
  }
}

export const CHAIN = {
  /** Tempo testnet "moderato" */
  id: 42431,
  rpcUrl: process.env.TEMPO_RPC_URL ?? 'https://rpc.moderato.tempo.xyz',
} as const

/** pathUSD on Tempo testnet, 6 decimals. */
export const PATH_USD = '0x20c0000000000000000000000000000000000000' as const
export const DECIMALS = 6

/** Chips are pathUSD base units (1 chip = 1e-6 pathUSD). */
export const CHIP_SCALE = 10 ** DECIMALS

/** Buy-in, in pathUSD. Paid via MPP 402 charge on join. */
export const BUY_IN_USD = Number(process.env.BUY_IN_USD ?? 10)
export const BUY_IN_CHIPS = BUY_IN_USD * CHIP_SCALE

/** Blinds, in chips (0.10 / 0.20 pathUSD by default). */
export const SMALL_BLIND = Number(process.env.SMALL_BLIND ?? 0.1) * CHIP_SCALE
export const BIG_BLIND = Number(process.env.BIG_BLIND ?? 0.2) * CHIP_SCALE

export const TABLE_SEATS = Number(process.env.TABLE_SEATS ?? 2)
export const MAX_HANDS = Number(process.env.MAX_HANDS ?? 20)

/** Auto check/fold a player who hasn't acted in this long (0 disables). */
export const ACT_TIMEOUT_MS = Number(process.env.ACT_TIMEOUT_SECONDS ?? 45) * 1000

/** How long an open-seat room waits for outside agents before house bots fill in. */
export const JOIN_WINDOW_MS = Number(process.env.JOIN_WINDOW_SECONDS ?? 120) * 1000

export const SERVER_PORT = Number(process.env.PORT ?? 4021)
export const SERVER_URL = process.env.SERVER_URL ?? `http://localhost:${SERVER_PORT}`

export function formatUsd(chips: number): string {
  return `$${(chips / CHIP_SCALE).toFixed(2)}`
}
