/**
 * Offline stand-ins for the DBC accounts the SDK reads while composing a launch: the
 * nuntius config it builds the pool on, and the quote mint's owner program. Test harness only.
 */
import BN from 'bn.js'
import { Connection, PublicKey } from '@solana/web3.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { launchPreset } from '../meteora.js'

const offline = new Connection('http://127.0.0.1:1', 'confirmed')
const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

type Coder = { size: (n: string) => number; decode: (n: string, b: Buffer) => Record<string, unknown> }

/** An account at its full size: Anchor 0.31's coder.encode writes into a fixed 1,000-byte buffer. */
export function encodeDbcAccount(name: string, value: unknown): Buffer {
  const program = DBC.createDbcProgram(offline, 'confirmed').program
  const coder = program.coder.accounts as unknown as Coder & {
    accountLayouts: Map<string, { layout?: { encode: (v: unknown, b: Buffer) => number } }>
  }
  const key = [...coder.accountLayouts.keys()].find((k) => k.toLowerCase() === name.toLowerCase())!
  const layout = coder.accountLayouts.get(key)!.layout!
  const acc = program.idl.accounts!.find((a) => a.name.toLowerCase() === name.toLowerCase())!
  const body = Buffer.alloc(coder.size(name) - 8)
  layout.encode(value, body)
  return Buffer.concat([Buffer.from(acc.discriminator), body])
}

/** A nuntius partner config on the preset, as the program stores it, priced in `quoteMint`. */
export function presetConfigAccount(quoteMint: string, feeClaimer: string, threshold = 50_000): Buffer {
  const program = DBC.createDbcProgram(offline, 'confirmed').program
  const coder = program.coder.accounts as unknown as Coder
  const acc = program.idl.accounts!.find((a) => a.name.toLowerCase() === 'poolconfig')!
  const zero = coder.decode(
    'poolConfig',
    Buffer.concat([Buffer.from(acc.discriminator), Buffer.alloc(coder.size('poolConfig') - 8)]),
  )
  const p = launchPreset(threshold)
  return encodeDbcAccount('poolConfig', {
    ...zero,
    quoteMint: new PublicKey(quoteMint),
    feeClaimer: new PublicKey(feeClaimer),
    leftoverReceiver: new PublicKey(feeClaimer),
    poolFees: {
      ...(zero.poolFees as object),
      baseFee: { ...(zero.poolFees as { baseFee: object }).baseFee, ...p.poolFees.baseFee },
    },
    migrationOption: 1,
    migrationFeeOption: 2,
    tokenType: 0,
    quoteTokenFlag: 0,
    tokenDecimal: 6,
    activationType: 1,
    migrationQuoteThreshold: p.migrationQuoteThreshold,
    sqrtStartPrice: p.sqrtStartPrice,
    curve: [...p.curve, ...Array(20 - p.curve.length).fill({ sqrtPrice: new BN(0), liquidity: new BN(0) })],
  })
}

/** A connection that serves this config and answers every other account as an SPL Token mint. */
export function launchConnection(config: string, configData: Buffer): Connection {
  const info = (k: PublicKey) =>
    k.toBase58() === config
      ? { owner: DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID, data: configData, lamports: 1, executable: false, rentEpoch: 0 }
      : { owner: new PublicKey(SPL_TOKEN), data: Buffer.alloc(82), lamports: 1, executable: false, rentEpoch: 0 }
  return {
    rpcEndpoint: 'offline',
    commitment: 'confirmed',
    getAccountInfo: async (k: PublicKey) => info(k),
    getAccountInfoAndContext: async (k: PublicKey) => ({ context: { slot: 1 }, value: info(k) }),
  } as unknown as Connection
}
