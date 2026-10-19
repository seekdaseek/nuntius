// nuntius's two partner configs as created on mainnet, cloned into a local validator
// (scripts/partner-configs-localnet.sh). A launch through /api/launch/create by a creator who
// can pay, on each config, after the needs_sol check has refused one who cannot (3e20569).
// Then the USDC side end to end through the API: a backing granted in USDC, one buy by the
// executor into the backer's own wallet, a revoke, and a pull the chain refuses after it.
// USDC's mint is mainnet's with one change, a local mint authority, so the backer can hold some.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { createKeyPairSignerFromBytes, generateKeyPairSigner, type Address } from '@solana/kit'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { Executor, rpcChain, type ChainPort } from './executor.js'
import { createLogger } from './log.js'
import { pullInstruction, readAta } from './mandate-chain.js'
import { launchCostLamports } from './launch-api.js'
import { meteoraConnection, readLaunch } from './meteora.js'
import { CLIENT_HEADER } from './client-version.js'
import { PULL_BUDGET, signAndSend } from './tx.js'
import type { Config } from './config.js'
import {
  assertOk,
  ataFor,
  deviceSignAndSend,
  funded,
  LOCALNET_RPC,
  requireLocal,
  requiredSigners,
  signAndLand,
  tokenBalance,
} from './test/localnet.js'

const AUTHORITY = process.env.LOCALNET_USDC_AUTHORITY ?? ''
const skip = !LOCALNET_RPC
  ? 'LOCALNET_RPC not set'
  : process.env.LOCALNET_PARTNER_CONFIGS !== '1' || !AUTHORITY
    ? 'run scripts/partner-configs-localnet.sh (the partner configs cloned, USDC with a local mint authority)'
    : false

const CONFIGS = {
  SKR: 'DdiaEHahNnz41GHh2AHCsZqGuuoW1A1nnjDKFN8bYM3d',
  USDC: 'HyT5SubGeApBbRce3KQdkaPJv8K4yFHSg7bLrtu15eSk',
} as const
const MINTS = {
  SKR: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const
const DAY = 86_400

const step = (name: string, data: Record<string, unknown>) =>
  console.log(`  ${name}: ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)

test('the partner configs on localnet: launches that pay, and a USDC backing end to end', { skip, timeout: 300_000 }, async (t) => {
  const rpc = requireLocal()
  const conn = meteoraConnection(LOCALNET_RPC)
  const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')

  // --- 0. What the validator holds is mainnet's ----------------------------------------------
  for (const q of ['SKR', 'USDC'] as const) {
    const c = await client.state.getPoolConfig(new PublicKey(CONFIGS[q]))
    assert.ok(c, `the ${q} config is on this validator`)
    assert.equal(c!.quoteMint.toBase58(), MINTS[q], `the ${q} config is priced in ${q}`)
    step(`0 ${q} config`, {
      config: CONFIGS[q],
      threshold: c!.migrationQuoteThreshold.toString(),
      migrationOption: Number(c!.migrationOption),
      migrationFeeOption: Number(c!.migrationFeeOption),
    })
  }
  const authority = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(AUTHORITY, 'utf8'))))
  const usdcMint = await conn.getAccountInfo(new PublicKey(MINTS.USDC))
  assert.equal(new PublicKey(usdcMint!.data.subarray(4, 36)).toBase58(), authority.address, 'USDC mints locally')

  // --- Actors and the server ----------------------------------------------------------------
  const creator = await funded(rpc, 2)
  const backer = await funded(rpc, 2)
  const executor = await funded(rpc, 2)
  const poor = await generateKeyPairSigner() // no SOL at all
  const usdc = MINTS.USDC as Address
  const [backerUsdc] = await findAssociatedTokenPda({ mint: usdc, owner: backer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  assertOk(
    await signAndSend(rpc, backer, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: backer, mint: usdc, owner: backer.address }),
      getMintToInstruction({ mint: usdc, token: backerUsdc, mintAuthority: authority, amount: 100_000_000n }),
    ]),
  )
  // The executor's own USDC account: each buy's pull lands there and its swap empties it.
  const executorUsdc = await ataFor(rpc, executor, usdc, executor.address)

  const db = openDb(':memory:')
  const store = new Store(db)
  const mandates = new MandateStore(db)
  const pushes: string[] = []
  const push: PushPort = { toAddress: async (_a, m) => (pushes.push(m.title), [200]) }
  const lines: string[] = []
  const log = createLogger((l) => lines.push(l))
  const receipts = new Receipts(mandates, push, log, 'localnet')
  const real = rpcChain(rpc, executor, PULL_BUDGET, conn)
  // A day-long period sends its buy up to 10 minutes in (buyJitterS). The executor is told the
  // clock is 10 minutes on, which only skips that wait: the period is still the program's first.
  const chain: ChainPort = { ...real, clock: async () => (await real.clock!()) + 600n }
  const ex = new Executor({ store: mandates, chain, receipts, log, settleMs: 30_000 })
  const cfg = {
    cluster: 'localnet' as const,
    rpcUrl: LOCALNET_RPC,
    mints: [
      { symbol: 'USDC', mint: MINTS.USDC, decimals: 6 },
      { symbol: 'SKR', mint: MINTS.SKR, decimals: 6, maxPerPeriodUi: '55' },
    ],
    maxPerPeriodUi: '100',
    delegateePath: null,
    executorIntervalMs: 30_000,
    guardIntervalMs: 60_000,
    demoEndpoints: false,
    launches: true,
    launchConfigs: { ...CONFIGS },
  }
  const config = { port: 0, domain: 'localhost', heliusRpc: null, fcmServiceAccount: null, fcmProjectId: null }
  // No executor here: the test ticks it itself, so confirm's kick cannot race a tick.
  const app = createApp(config as unknown as Config, store, null, {
    mandates,
    cfg,
    rpc,
    delegatee: executor.address,
    receipts,
    executor: null,
    conn,
    origin: 'http://localhost',
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const session = (address: string, tag: string) => {
    const token = tag.repeat(43).slice(0, 43)
    store.createSession(token, address, Date.now())
    store.claimSgtMint(token, `Sgt${tag.repeat(40)}`.slice(0, 44))
    return token
  }
  const S = { creator: session(creator.address, 'C'), backer: session(backer.address, 'B'), poor: session(poor.address, 'P') }
  const call = async (path: string, body: Record<string, unknown>) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1.1.0' },
      body: JSON.stringify(body),
    })
    return { status: r.status, json: (await r.json()) as Record<string, any> }
  }
  const launchRows = () => (mandates.database.prepare('SELECT COUNT(*) AS n FROM launches').get() as { n: number }).n
  const quoted = await launchCostLamports((n) => rpc.getMinimumBalanceForRentExemption(n).send())

  // --- 1. A launch on each config: refused with its cost for a wallet that cannot pay, then paid --
  const pools: Record<string, string> = {}
  for (const q of ['SKR', 'USDC'] as const) {
    const body = { name: `proof ${q.toLowerCase()}`, symbol: `PRF${q.slice(0, 1)}`, quote: q }
    const refused = await call('/api/launch/create', { session: S.poor, ...body })
    assert.equal(refused.status, 402)
    assert.equal(refused.json.error, 'needs_sol')
    assert.match(refused.json.message, /^Launching costs about 0\.\d{4} SOL; this wallet has 0\.0000 SOL\.$/)
    assert.equal(launchRows(), Object.keys(pools).length, 'a refused launch records nothing')

    const before = (await rpc.getBalance(creator.address).send()).value
    const c = await call('/api/launch/create', { session: S.creator, ...body })
    assert.equal(c.status, 200, JSON.stringify(c.json))
    assert.equal(c.json.config, CONFIGS[q])
    assert.deepEqual(new Set(requiredSigners(c.json.transactionBase64)), new Set([creator.address, c.json.baseMint]))
    assert.equal((await call('/api/launch/confirm', { session: S.creator, baseMint: c.json.baseMint })).json.error, 'not_on_chain_yet')
    const landed = assertOk(await deviceSignAndSend(rpc, creator, c.json.transactionBase64))
    const confirmed = await call('/api/launch/confirm', { session: S.creator, baseMint: c.json.baseMint })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json))
    assert.equal(confirmed.json.launch.pool, c.json.pool)
    assert.equal(confirmed.json.launch.quoteMint, MINTS[q])
    assert.equal(confirmed.json.launch.route, 'dbc')
    assert.equal(mandates.launchByMint(c.json.baseMint)?.status, 'live')
    const spent = before - (await rpc.getBalance(creator.address).send()).value
    assert.ok(spent <= quoted, `the creator paid ${spent}, no more than the ${quoted} the check quotes`)
    step(`1 ${q} launch`, { pool: c.json.pool, baseMint: c.json.baseMint, signature: landed.signature, spentLamports: spent, quotedLamports: quoted })
    pools[q] = c.json.pool
  }

  // --- 2. A USDC backing, granted through the API, and its first buy -----------------------
  const pool = pools.USDC!
  const back = await call('/api/mandates/back', { session: S.backer, pool, symbol: 'USDC', amount: '1', period: 'day', untilDays: 30 })
  assert.equal(back.status, 200, JSON.stringify(back.json))
  assert.deepEqual(requiredSigners(back.json.transactionBase64), [backer.address], 'the backer signs alone')
  const grant = assertOk(await deviceSignAndSend(rpc, backer, back.json.transactionBase64))
  const activated = await call('/api/mandates/confirm', { session: S.backer, mandateId: back.json.mandateId })
  assert.equal(activated.status, 200, JSON.stringify(activated.json))
  assert.equal(activated.json.mandate.status, 'active')
  const m = mandates.getMandate(back.json.mandateId)!
  const b = mandates.backingOf(m.id)!
  assert.equal(b.pool, pool)
  step('2a USDC grant', { signature: grant.signature, delegationPda: m.delegationPda, mandateId: m.id })

  const launchMint = b.baseMint as Address
  const usdcBefore = await tokenBalance(rpc, backerUsdc)
  const out = await ex.tick()
  assert.equal(out[m.id], 'landed', JSON.stringify({ out, lines: lines.slice(-5) }))
  const row = mandates.pullsFor(m.delegationPda).at(-1)!
  const got = await tokenBalance(rpc, b.backerBaseAta as Address)
  assert.ok(got > 0n, 'the launch token is in the backer’s own account')
  assert.equal(usdcBefore - (await tokenBalance(rpc, backerUsdc)), 1_000_000n, 'exactly 1 USDC left the backer')
  assert.equal(await tokenBalance(rpc, executorUsdc), 0n, 'the executor holds no USDC after the buy')
  const [executorBase] = await findAssociatedTokenPda({ mint: launchMint, owner: executor.address, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  assert.equal((await readAta(rpc, executorBase)).exists, false, 'the executor never holds the launch token')
  const buy = mandates.events(backer.address).find((e) => e.signature === row.signature)
  assert.equal(buy?.kind, 'buy')
  // The curve keeps the 1 USDC less its trading fee (the config's cliff fee, in billionths).
  const fee = BigInt((await client.state.getPoolConfig(new PublicKey(CONFIGS.USDC)))!.poolFees.baseFee.cliffFeeNumerator.toString())
  const L = await readLaunch(conn, pool)
  assert.equal(L.quoteRaised, (1_000_000n - (1_000_000n * fee) / 1_000_000_000n).toString(), 'the curve raised the 1 USDC, less its fee')
  step('2b USDC buy', { signature: row.signature, launchTokenToBacker: got, curveQuoteRaised: L.quoteRaised, feeNumerator: fee })
  assert.equal((await ex.tick())[m.id], 'period_done', 'one buy per period')

  // --- 3. A revoke through the API, and the chain refuses the next pull ---------------------
  const rv = await call('/api/mandates/revoke', { session: S.backer, delegationPda: m.delegationPda })
  assert.equal(rv.status, 200, JSON.stringify(rv.json))
  const revoked = assertOk(await deviceSignAndSend(rpc, backer, rv.json.transactionBase64))
  const rc = await call('/api/mandates/revoke-confirm', { session: S.backer, delegationPda: m.delegationPda })
  assert.equal(rc.status, 200, JSON.stringify(rc.json))
  assert.equal(rc.json.revoked, true)
  assert.equal(rc.json.tokenAccountDelegate, null, 'no delegate left on the backer’s USDC account')
  assert.equal(mandates.getMandate(m.id)!.status, 'revoked')
  const dead = await signAndLand(rpc, executor, [
    await pullInstruction({
      delegatee: executor,
      delegationPda: m.delegationPda as Address,
      delegator: backer.address,
      delegatorAta: backerUsdc,
      receiverAta: executorUsdc,
      mint: usdc,
      amount: 1n,
    }),
  ])
  assert.ok(dead.err, 'a pull after the revoke fails on chain')
  assert.equal(await tokenBalance(rpc, backerUsdc), usdcBefore - 1_000_000n, 'nothing more left the backer')
  assert.equal((await ex.tick())[m.id], undefined, 'the executor no longer runs a revoked backing')
  step('3 revoke, then a refused pull', { revoke: revoked.signature, pull: dead.signature, err: dead.err })
})
