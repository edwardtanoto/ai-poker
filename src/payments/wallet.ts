import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { http, publicActions, walletActions, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions, createClient } from 'viem/tempo'
import { CHAIN, DECIMALS, PATH_USD } from '../config.js'

export type Wallet = {
  account: PrivateKeyAccount
  client: TempoClient
  address: Address
  /** pathUSD balance in base units. */
  balance: () => Promise<bigint>
  /** Sends pathUSD (base units) to `to`; returns tx hash. */
  send: (to: Address, baseUnits: bigint) => Promise<`0x${string}`>
}

type TempoClient = ReturnType<typeof makeClient>

function makeClient(account: PrivateKeyAccount) {
  return createClient({
    account,
    chain: tempoModerato,
    transport: http(CHAIN.rpcUrl),
  })
    .extend(publicActions)
    .extend(walletActions)
}

/**
 * Loads a persisted wallet or creates a fresh one, then tops it up from the
 * Tempo testnet faucet when the pathUSD balance is low. Pass
 * `{ autofund: false }` for wallets that must start empty (e.g. spectator
 * wallets funded with fixed top-ups from the treasury).
 */
export async function openWallet(
  name: string,
  keyFile: string,
  options: { autofund?: boolean } = {},
): Promise<Wallet> {
  let privateKey: `0x${string}`
  if (existsSync(keyFile)) {
    privateKey = JSON.parse(readFileSync(keyFile, 'utf8')).privateKey
  } else {
    privateKey = generatePrivateKey()
    mkdirSync(dirname(keyFile), { recursive: true })
    writeFileSync(keyFile, JSON.stringify({ name, privateKey }, null, 2), { mode: 0o600 })
  }

  const account = privateKeyToAccount(privateKey)
  const client = makeClient(account)

  const wallet: Wallet = {
    account,
    client,
    address: account.address,
    balance: async () => {
      const { amount } = await Actions.token.getBalance(client, {
        account: account.address,
        token: PATH_USD,
      })
      return amount
    },
    send: async (to, baseUnits) => {
      const { receipt } = await Actions.token.transferSync(client, {
        to,
        token: PATH_USD,
        amount: baseUnits,
      })
      return receipt.transactionHash
    },
  }

  if (options.autofund !== false) await ensureFunded(wallet, name)
  return wallet
}

/**
 * Wraps a wallet so every send first tops the balance back up from the
 * testnet faucet when it dips below `minBaseUnits`. Keeps a long-running
 * treasury solvent through spectator top-ups and bet payouts. Testnet only —
 * there is no faucet to lean on with real funds.
 */
export function withAutoRefill(wallet: Wallet, name: string, minBaseUnits: bigint): Wallet {
  let refilling: Promise<void> | null = null
  return {
    ...wallet,
    send: async (to, baseUnits) => {
      refilling ??= ensureFunded(wallet, name, minBaseUnits).finally(() => {
        refilling = null
      })
      await refilling.catch((error) => {
        // A dry faucet shouldn't block sends while the balance still covers them.
        console.error(`[wallet:${name}] faucet refill failed`, error)
      })
      return wallet.send(to, baseUnits)
    },
  }
}

async function ensureFunded(wallet: Wallet, name: string, min?: bigint): Promise<void> {
  min ??= 100n * 10n ** BigInt(DECIMALS) // keep at least 100 pathUSD around
  const balance = await wallet.balance().catch(() => 0n)
  if (balance >= min) return
  console.log(`[wallet:${name}] balance low (${balance}), requesting faucet funds…`)
  await Actions.faucet.fund(wallet.client, { account: wallet.account })
  // Faucet transactions land asynchronously — poll briefly
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const b = await wallet.balance().catch(() => 0n)
    if (b >= min) {
      console.log(`[wallet:${name}] funded: ${b} base units pathUSD`)
      return
    }
  }
  throw new Error(`[wallet:${name}] faucet funding did not arrive in time`)
}
