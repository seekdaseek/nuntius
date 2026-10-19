// The buy composer and launch preset (BRIEF-DBC). Instructions are encoded by the Meteora
// SDKs' own IDL coders; pools are synthetic accounts decoded and re-encoded with those coders.
// No Meteora program code runs here, and no RPC is called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from '@solana/kit'
import {
  ataOf,
  budgetInstructions,
  failedInstruction,
  launchInstructions,
  launchPreset,
  MAX_URI,
  minimumOut,
  PULL_INDEX,
  quoteDbc,
  quoteDamm,
  swapInstruction,
  SWAP_INDEX,
  meteoraConnection,
  backRefusal,
  canonicalDammPool,
  DBC_PROGRAM,
  swapFailure,
  readLaunch,
  UnsupportedLaunch,
  curveStage,
  type CurveFacts,
} from './meteora.js'
import { fakeHelius } from './test/fake-helius.js'
import { launchConnection, presetConfigAccount } from './test/dbc-fakes.js'
import { CpAmm, cpAmmCoder, CpAmmIdl, POOL_TOKEN_A_MINT_OFFSET } from '@meteora-ag/cp-amm-sdk'

const offline = new Connection('http://127.0.0.1:1', 'confirmed')
const K = () => Keypair.generate().publicKey.toBase58()
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SKR = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'

test('the swap: exact-in, paid by the executor from its quote account, tokens to the backer', async () => {
  const delegatee = K()
  const backerBaseAta = K()
  const s = {
    route: 'dbc' as const,
    pool: K(),
    config: K(),
    baseVault: K(),
    quoteVault: K(),
    baseMint: K(),
    quoteMint: USDC,
  }
  const ix = await swapInstruction(offline, s, { delegatee, backerBaseAta, amountIn: 1_000_000n, minimumOut: 970_198n })
  const acc = ix.accounts!
  assert.equal(ix.programAddress, 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
  assert.equal(acc[3]!.address, await ataOf(delegatee, USDC), 'input: the executor’s own quote account')
  assert.equal(acc[4]!.address, backerBaseAta, 'output: the backer’s account')
  assert.equal(acc[9]!.address, delegatee)
  assert.equal(acc[9]!.role, AccountRole.READONLY_SIGNER, 'the executor signs as payer')
  const data = Buffer.from(ix.data!)
  assert.equal(data.readBigUInt64LE(8), 1_000_000n, 'amount in = the pull')
  assert.equal(data.readBigUInt64LE(16), 970_198n, 'minimum out')
  assert.equal(data[24], 0, 'swap mode: exact in (never partial fill)')
  const d = {
    route: 'damm_v2' as const,
    pool: K(),
    tokenAMint: s.baseMint,
    tokenBMint: USDC,
    tokenAVault: K(),
    tokenBVault: K(),
    baseMint: s.baseMint,
    quoteMint: USDC,
  }
  const ix2 = await swapInstruction(offline, d, { delegatee, backerBaseAta, amountIn: 5n, minimumOut: 4n })
  assert.equal(ix2.programAddress, 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
  assert.equal(ix2.accounts![2]!.address, await ataOf(delegatee, USDC))
  assert.equal(ix2.accounts![3]!.address, backerBaseAta)
  assert.equal(Buffer.from(ix2.data!)[24], 0)
})

test('instruction order: [limit, price, pull, swap], so a failure index says which leg failed', () => {
  assert.equal(budgetInstructions().length, 2)
  assert.equal(PULL_INDEX, 2)
  assert.equal(SWAP_INDEX, 3)
  assert.equal(failedInstruction('{"InstructionError":[3,{"Custom":6003}]}'), 3)
  assert.equal(failedInstruction('{"InstructionError":[2,{"Custom":400}]}'), 2)
  assert.equal(failedInstruction(null), null)
  assert.equal(failedInstruction('not json'), null)
})

test('minimum out is the quote less the slippage bound', () => {
  assert.equal(minimumOut(1_000_000n, 200), 980_000n)
  assert.equal(minimumOut(989_998n, 200), 970_198n) // the spike's mainnet quote and minimum
  assert.throws(() => minimumOut(1n, 10_000))
})

// A synthetic curve built from the launch preset, encoded with the SDK's coder.
function curve(quoteReserve: bigint, threshold = 1_000) {
  const program = DBC.createDbcProgram(offline).program
  const params = launchPreset(threshold)
  const coder = program.coder.accounts
  const zero = (name: string) => {
    const acc = program.idl.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase())!
    return coder.decode(name, Buffer.concat([Buffer.from(acc.discriminator), Buffer.alloc(coder.size(name) - 8)]))
  }
  const cfg = zero('poolConfig')
  const config = {
    ...cfg,
    quoteMint: new PublicKey(USDC),
    poolFees: {
      ...cfg.poolFees,
      baseFee: {
        ...cfg.poolFees.baseFee,
        cliffFeeNumerator: params.poolFees.baseFee.cliffFeeNumerator,
        baseFeeMode: 0,
      },
    },
    activationType: 1,
    migrationQuoteThreshold: params.migrationQuoteThreshold,
    migrationSqrtPrice: params.migrationQuoteThreshold.isZero() ? new BN(0) : new BN('79226673521066979257578248091'),
    sqrtStartPrice: params.sqrtStartPrice,
    curve: [...params.curve, ...Array(20 - params.curve.length).fill({ sqrtPrice: new BN(0), liquidity: new BN(0) })],
  } as DBC.PoolConfig
  const vp = zero('virtualPool')
  const pool = {
    ...vp,
    poolState: {
      ...vp.poolState,
      quoteReserve: new BN(quoteReserve.toString()),
      sqrtPrice: params.sqrtStartPrice,
      baseReserve: new BN('800000000000000'),
    },
  } as unknown as DBC.VirtualPool
  return { pool, config, threshold: BigInt(params.migrationQuoteThreshold.toString()) }
}

test('the DBC quote: full amount on an open curve, a wait once it fills', () => {
  const open = curve(0n)
  const q = quoteDbc(open.pool, open.config, 1_000_000n, 200, 1_800_000_000, 1)
  assert.equal(q.kind, 'buy')
  if (q.kind === 'buy') {
    assert.equal(q.amountIn, 1_000_000n, 'the whole period amount is spent')
    assert.ok(q.quotedOut > 0n)
    assert.equal(q.minimumOut, minimumOut(q.quotedOut, 200))
  }
  const full = curve(0n)
  ;(full.pool as unknown as { poolState: { quoteReserve: BN } }).poolState.quoteReserve = new BN(
    full.threshold.toString(),
  )
  assert.deepEqual(quoteDbc(full.pool, full.config, 1_000_000n, 200, 1_800_000_000, 1), {
    kind: 'wait',
    reason: 'migrating',
  })
})

test('the launch: one pool on the fixed config, one transaction under 1,232 bytes, two signers', async () => {
  const config = K()
  const conn = launchConnection(config, presetConfigAccount(SKR, K()))
  const creator = K()
  const baseMint = K()
  const uri = `https://nuntius.ochinimus.app/m/${baseMint}.json`
  assert.ok(uri.length <= MAX_URI)
  const ixs = await launchInstructions(conn, { creator, config, name: 'nimus', symbol: 'NIMUS', uri, baseMint })
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(creator as Address), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 1n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  )
  const tx = compileTransaction(msg)
  const bytes = getTransactionEncoder().encode(tx).length
  assert.deepEqual(Object.keys(tx.signatures).sort(), [creator, baseMint].sort(), 'creator and mint key only')
  assert.ok(bytes <= 1232, `${bytes} bytes`)
  // No config is created per launch: only the pool on nuntius's config.
  const dbcIxs = ixs.filter((ix) => ix.programAddress === DBC_PROGRAM)
  assert.equal(dbcIxs.length, 1)
  assert.equal(Buffer.from(dbcIxs[0]!.data!.slice(0, 8)).toString('hex'), '8c55d7b06636684f')
  assert.equal(dbcIxs[0]!.accounts![0]!.address, config)
  console.log(`  launch transaction: ${bytes} bytes`)
  await assert.rejects(
    launchInstructions(conn, {
      creator,
      config,
      name: 'x',
      symbol: 'XX',
      uri: `https://${'a'.repeat(MAX_URI)}`,
      baseMint,
    }),
    /URI/,
  )
})

const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=test'

test("elsewhere (localnet): the SDKs' connection keeps the plain getProgramAccounts", () => {
  const plain = new Connection('http://127.0.0.1:8899').getProgramAccounts
  assert.equal(meteoraConnection('http://127.0.0.1:8899').getProgramAccounts, plain)
})

test('the Meteora DAMM v2 lookup pages on Helius too (connection.getProgramAccounts → V2)', async () => {
  const baseMint = Keypair.generate().publicKey
  const poolKey = K()
  const size = cpAmmCoder.accounts.size('Pool')
  const data = Buffer.alloc(size)
  Buffer.from(CpAmmIdl.accounts.find((a) => a.name === 'Pool')!.discriminator).copy(data)
  baseMint.toBuffer().copy(data, POOL_TOKEN_A_MINT_OFFSET)
  const { calls, doFetch } = fakeHelius(
    [{ pubkey: poolKey, data: data.toString('base64'), owner: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' }],
    1000,
  )
  const conn = meteoraConnection(HELIUS, doFetch)
  const pools = await new CpAmm(conn).fetchPoolStatesByTokenAMint(baseMint)
  assert.equal(pools.length, 1)
  assert.equal(pools[0]!.publicKey.toBase58(), poolKey)
  assert.equal(pools[0]!.account.tokenAMint.toBase58(), baseMint.toBase58())
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'getProgramAccountsV2')
  const filters = (calls[0]!.params[1] as { filters: { memcmp?: { offset: number; bytes: string } }[] }).filters
  assert.ok(
    filters.some((f) => f.memcmp?.offset === POOL_TOKEN_A_MINT_OFFSET && f.memcmp.bytes === baseMint.toBase58()),
  )
})

// --- A3b: only the pool the DBC program migrates into is ever bought -------------------

test('the canonical DAMM v2 pool: derived from the migration config the fee option names', () => {
  const base = K()
  const want = DBC.deriveDammV2PoolAddress(
    new PublicKey('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp'), // FixedBps100, option 2 (the preset's)
    new PublicKey(base),
    new PublicKey(USDC),
  ).toBase58()
  assert.equal(canonicalDammPool(2, base, USDC), want)
  assert.equal(DBC.DAMM_V2_MIGRATION_FEE_ADDRESS[2]!.toBase58(), 'Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp')
  assert.notEqual(canonicalDammPool(3, base, USDC), want, 'another fee option is another config, another pool')
  assert.throws(() => canonicalDammPool(7, base, USDC), /unknown migration fee option/)
})

type AnyCoder = {
  size: (n: string) => number
  decode: (n: string, b: Buffer) => any
  encode: (n: string, v: unknown) => Promise<Buffer>
}
type AnyIdl = { accounts?: { name: string; discriminator: number[] }[] }

/** A zeroed account of this type, decoded by the Program's own (camelCase) coder. */
function zeroed(coder: AnyCoder, idl: AnyIdl, name: string) {
  const acc = idl.accounts!.find((a) => a.name.toLowerCase() === name.toLowerCase())!
  return coder.decode(name, Buffer.concat([Buffer.from(acc.discriminator), Buffer.alloc(coder.size(name) - 8)]))
}

/**
 * Encodes an account at its full size. Anchor 0.31's coder.encode writes into a fixed
 * 1,000-byte buffer, and a DBC PoolConfig is larger than that.
 */
function encoded(coder: AnyCoder, idl: AnyIdl, name: string, value: unknown): Buffer {
  const layouts = (
    coder as unknown as {
      accountLayouts: Map<string, { encode?: unknown; layout?: { encode: (v: unknown, b: Buffer) => number } }>
    }
  ).accountLayouts
  const key = [...layouts.keys()].find((k) => k.toLowerCase() === name.toLowerCase())!
  const l = layouts.get(key)!
  const enc = (l.layout ?? (l as unknown as { encode: (v: unknown, b: Buffer) => number })).encode.bind(l.layout ?? l)
  const acc = idl.accounts!.find((a) => a.name.toLowerCase() === name.toLowerCase())!
  const body = Buffer.alloc(coder.size(name) - 8)
  enc(value, body)
  return Buffer.concat([Buffer.from(acc.discriminator), body])
}

/** A connection that serves these accounts by address, as Anchor and the SDKs read them. */
function accounts(map: Map<string, { owner: string; data: Buffer }>, slot = 1) {
  const info = (k: PublicKey) => {
    const a = map.get(k.toBase58())
    return a ? { owner: new PublicKey(a.owner), data: a.data, lamports: 1, executable: false, rentEpoch: 0 } : null
  }
  return {
    rpcEndpoint: 'fake',
    commitment: 'confirmed',
    getSlot: async () => slot,
    getAccountInfo: async (k: PublicKey) => info(k),
    getAccountInfoAndContext: async (k: PublicKey) => ({ context: { slot }, value: info(k) }),
    getProgramAccounts: async () => {
      throw new Error('readLaunch must not search pools')
    },
  } as unknown as Connection
}

/** A migrated curve for (base, USDC) on the preset's config, plus DAMM v2 pools at the given addresses. */
async function migratedLaunch(dammPools: string[], base: string) {
  const dbc = DBC.createDbcProgram(offline).program
  const amm = new CpAmm(offline)._program
  const dbcCoder = dbc.coder.accounts as unknown as AnyCoder
  const ammCoder = amm.coder.accounts as unknown as AnyCoder
  const { pool: vp0, config: cfg0 } = curve(1_000n)
  const configKey = K()
  const poolKey = K()
  const cfg = { ...cfg0, migrationOption: 1, migrationFeeOption: 2, tokenDecimal: 6 }
  const ps0 = (vp0 as unknown as { poolState: Record<string, unknown> }).poolState
  const vp = {
    ...vp0,
    poolState: {
      ...ps0,
      config: new PublicKey(configKey),
      baseMint: new PublicKey(base),
      quoteReserve: cfg0.migrationQuoteThreshold,
      isMigrated: 1,
    },
  }
  const DBC_ID = DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()
  const map = new Map<string, { owner: string; data: Buffer }>()
  map.set(configKey, { owner: DBC_ID, data: encoded(dbcCoder, dbc.idl as AnyIdl, 'poolConfig', cfg) })
  map.set(poolKey, { owner: DBC_ID, data: encoded(dbcCoder, dbc.idl as AnyIdl, 'virtualPool', vp) })
  for (const k of dammPools) {
    const st = {
      ...zeroed(ammCoder, amm.idl as AnyIdl, 'pool'),
      tokenAMint: new PublicKey(base),
      tokenBMint: new PublicKey(USDC),
      tokenAVault: new PublicKey(K()),
      tokenBVault: new PublicKey(K()),
    }
    map.set(k, {
      owner: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
      data: encoded(ammCoder, amm.idl as AnyIdl, 'pool', st),
    })
  }
  return { conn: accounts(map), poolKey }
}

test('after migration the buy goes to the canonical pool, never a decoy for the same pair', async () => {
  const base = K()
  const decoy = K()
  const canonical = canonicalDammPool(2, base, USDC)
  const { conn, poolKey } = await migratedLaunch([decoy, canonical], base)
  const L = await readLaunch(conn, poolKey)
  assert.equal(L.route, 'damm_v2')
  assert.equal(L.dammPool, canonical)
  assert.equal(L.swap?.pool, canonical)
  // A stored pool that is not the canonical one is refused, not bought.
  await assert.rejects(readLaunch(conn, poolKey, decoy), /is not the curve's migrated pool/)
  assert.equal((await readLaunch(conn, poolKey, canonical)).dammPool, canonical)
})

test('migrated, but the canonical pool is not readable yet: the buy waits, it does not look elsewhere', async () => {
  const base = K()
  const { conn, poolKey } = await migratedLaunch([K()], base)
  const L = await readLaunch(conn, poolKey)
  assert.equal(L.route, 'migrating')
  assert.equal(L.swap, null)
})

// --- A5b: pools "Back a launch" cannot buy are refused with one sentence --------------

const plain: CurveFacts = {
  tokenType: 0,
  quoteTokenFlag: 0,
  migrationOption: 1,
  baseFeeMode: 0,
  firstFactor: 0,
  secondFactor: 0n,
  thirdFactor: 0n,
  activationType: 1,
  activationPoint: 1_000n,
}

test('back refusals: Token-2022, DAMM v1, an active rate limiter; a plain curve passes', () => {
  assert.equal(backRefusal(plain, 2_000, 1), null)
  assert.match(backRefusal({ ...plain, tokenType: 1 }, 2_000, 1)!, /Token-2022/)
  assert.match(backRefusal({ ...plain, quoteTokenFlag: 1 }, 2_000, 1)!, /priced in a Token-2022 token/)
  assert.match(backRefusal({ ...plain, migrationOption: 0 }, 2_000, 1)!, /DAMM v1/)
  const limiter = { ...plain, baseFeeMode: 2, firstFactor: 10, secondFactor: 600n, thirdFactor: 1_000_000n }
  assert.match(backRefusal(limiter, 1_300, 1)!, /opening window.*about 5 minutes/)
  assert.equal(backRefusal(limiter, 1_601, 1), null, 'once the window has passed the limiter never applies again')
  assert.equal(backRefusal({ ...limiter, firstFactor: 0, secondFactor: 0n, thirdFactor: 0n }, 1_300, 1), null)
  const bySlot = { ...limiter, activationType: 0, activationPoint: 100n, secondFactor: 150n }
  assert.match(backRefusal(bySlot, 0, 100)!, /about 1 minutes?/)
})

test('a transfer-hook pool is named as such', async () => {
  const key = K()
  const data = Buffer.concat([Buffer.from([237, 219, 184, 23, 42, 189, 169, 35]), Buffer.alloc(64)])
  const conn = accounts(new Map([[key, { owner: DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(), data }]]))
  await assert.rejects(
    readLaunch(conn, key),
    (e: unknown) => e instanceof UnsupportedLaunch && /transfer hook/.test(e.message),
  )
  await assert.rejects(readLaunch(conn, K()), /no DBC pool/)
})

test('the DAMM v2 quote does not depend on the decimals passed (they feed only price impact)', () => {
  const amm = new CpAmm(offline)._program
  const z = zeroed(amm.coder.accounts as unknown as AnyCoder, amm.idl as AnyIdl, 'pool')
  const st = {
    ...z,
    tokenAMint: new PublicKey(K()),
    tokenBMint: new PublicKey(USDC),
    liquidity: new BN('1000000000000000000000000'),
    sqrtPrice: new BN('18446744073709551616'),
    sqrtMinPrice: new BN('4295048016'),
    sqrtMaxPrice: new BN('79226673521066979257578248091'),
  }
  const a = quoteDamm(offline, st as never, USDC, 1_000_000n, 200, 1_800_000_000, 1, { base: 6, quote: 6 })
  const b = quoteDamm(offline, st as never, USDC, 1_000_000n, 200, 1_800_000_000, 1, { base: 9, quote: 6 })
  assert.equal(a.kind, 'buy')
  if (a.kind === 'buy') assert.ok(a.quotedOut > 0n)
  assert.deepEqual(a, b)
})

test('swap failures: classified by the program that failed and its code', () => {
  assert.equal(swapFailure('dbc', 6002), 'slippage')
  assert.equal(swapFailure('damm_v2', 6002), 'slippage')
  assert.equal(swapFailure('dbc', 6013), 'curve_full')
  assert.equal(swapFailure('dbc', 6033), 'no_room')
  assert.equal(swapFailure('damm_v2', 6023), 'no_room')
  assert.equal(swapFailure('damm_v2', 6013), 'error:6013', 'DAMM v2 has no curve to complete')
  assert.equal(swapFailure('dbc', 6043), 'error:6043')
  assert.equal(swapFailure('dbc', null), 'error:unknown')
})

// --- The crank's read (19 Oct): the nimus pool logged "Invalid account discriminator" ------

/** A connection whose reads fail, as web3.js words a rate limit, where `fails(n)` says so (n from 1). */
function failing(conn: Connection, fails: (n: number) => boolean) {
  let reads = 0
  const read = () => {
    reads += 1
    if (fails(reads)) throw new Error('429 Too Many Requests: Too Many Requests')
  }
  const c = conn as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const wrap =
    (name: string) =>
    async (...a: unknown[]) => (read(), c[name]!(...a))
  return {
    conn: {
      ...conn,
      getAccountInfo: wrap('getAccountInfo'),
      getAccountInfoAndContext: wrap('getAccountInfoAndContext'),
      getSlot: wrap('getSlot'),
    } as unknown as Connection,
    reads: () => reads,
  }
}
/** The n-th read fails, and only that one. */
const failingRead = (conn: Connection, n: number) => failing(conn, (i) => i === n)

/** A backed curve as the crank reads it: its pool, on a config that migrates to DAMM v2. */
function backedCurve(quoteReserve: bigint, isMigrated = 0) {
  const dbc = DBC.createDbcProgram(offline).program
  const coder = dbc.coder.accounts as unknown as AnyCoder
  const { pool: vp0, config: cfg0 } = curve(quoteReserve)
  const configKey = K()
  const poolKey = K()
  const base = K()
  const ps0 = (vp0 as unknown as { poolState: Record<string, unknown> }).poolState
  const vp = {
    ...vp0,
    poolState: { ...ps0, config: new PublicKey(configKey), baseMint: new PublicKey(base), isMigrated },
  }
  const cfg = { ...cfg0, migrationOption: 1, migrationFeeOption: 2 }
  const DBC_ID = DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()
  const map = new Map([
    [configKey, { owner: DBC_ID, data: encoded(coder, dbc.idl as AnyIdl, 'poolConfig', cfg) }],
    [poolKey, { owner: DBC_ID, data: encoded(coder, dbc.idl as AnyIdl, 'virtualPool', vp) }],
  ])
  return { conn: accounts(map), map, poolKey, configKey, base }
}

test('why: the SDK reads a pool again as the transfer-hook kind when its first read fails, so a 429 reads "Invalid account discriminator"', async () => {
  const { conn, poolKey, configKey } = backedCurve(0n)
  const sdk = (c: Connection) => new DBC.DynamicBondingCurveClient(c, 'confirmed').state
  // The bytes are a plain pool and config: read without a failure, the SDK decodes both.
  assert.ok(await sdk(conn).getPool(poolKey))
  assert.ok(await sdk(conn).getPoolConfig(configKey))
  // The first read fails, the SDK's catch swallows it, and the second read decodes the same
  // bytes as the transfer-hook variant: the logged error, with no wrong account anywhere.
  await assert.rejects(sdk(failingRead(conn, 1).conn).getPool(poolKey), /Invalid account discriminator/)
  await assert.rejects(sdk(failingRead(conn, 1).conn).getPoolConfig(configKey), /Invalid account discriminator/)
})

test('the crank reads each account once, a busy read is tried again, and the stage is right', async () => {
  const threshold = curve(0n).threshold
  const open = backedCurve(threshold - 1n)
  const ok = failingRead(open.conn, 0)
  assert.deepEqual(await curveStage(ok.conn, open.poolKey), { stage: 'open' })
  assert.equal(ok.reads(), 2, 'one read for the pool, one for its config')
  for (const n of [1, 2]) {
    const f = failingRead(open.conn, n)
    assert.deepEqual(await curveStage(f.conn, open.poolKey), { stage: 'open' }, `read ${n} failed once`)
    assert.equal(f.reads(), 3, 'the failed read, tried once more')
  }
  // Busy throughout: three tries of the pool, then a busy RPC, never "Invalid account discriminator".
  const busy = failing(open.conn, () => true)
  await assert.rejects(curveStage(busy.conn, open.poolKey), (e: unknown) => {
    assert.match((e as Error).message, /the Solana RPC is busy \(429 Too Many Requests/)
    assert.doesNotMatch((e as Error).message, /discriminator/)
    return true
  })
  assert.equal(busy.reads(), 3)
  const full = backedCurve(threshold)
  const dammPool = canonicalDammPool(2, full.base, USDC)
  assert.deepEqual(await curveStage(full.conn, full.poolKey), { stage: 'complete', dammPool })
  const moved = backedCurve(threshold, 1)
  assert.deepEqual(await curveStage(moved.conn, moved.poolKey), {
    stage: 'migrated',
    dammPool: canonicalDammPool(2, moved.base, USDC),
  })
})

test('the crank still calls a wrong account wrong: other bytes, another owner, or none', async () => {
  const c = backedCurve(0n)
  const DBC_ID = DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()
  const hooked = Buffer.concat([
    Buffer.from([237, 219, 184, 23, 42, 189, 169, 35]),
    c.map.get(c.poolKey)!.data.subarray(8),
  ])
  const swap = (key: string, v: { owner: string; data: Buffer }) => accounts(new Map([...c.map, [key, v]]))
  await assert.rejects(
    curveStage(swap(c.poolKey, { owner: DBC_ID, data: hooked }), c.poolKey),
    /is not a DBC virtualPool account/,
  )
  await assert.rejects(
    curveStage(
      swap(c.poolKey, { ...c.map.get(c.poolKey)!, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }),
      c.poolKey,
    ),
    /is not a DBC virtualPool account/,
  )
  await assert.rejects(
    curveStage(swap(c.configKey, { owner: DBC_ID, data: c.map.get(c.poolKey)!.data }), c.poolKey),
    /is not a DBC poolConfig account/,
  )
  await assert.rejects(curveStage(c.conn, K()), /no DBC pool at/)
})

// --- readLaunch on a busy RPC (19 Oct): the backing page answered 404 during 429 bursts ----

test('readLaunch: the first two reads 429, the third answers, and it is the launch', async () => {
  const c = backedCurve(0n)
  const f = failing(c.conn, (n) => n <= 2)
  const L = await readLaunch(f.conn, c.poolKey)
  assert.equal(L.pool, c.poolKey)
  assert.equal(L.route, 'dbc')
  assert.equal(L.baseMint, c.base)
})

test('readLaunch: an RPC that stays busy is a busy RPC, never "no DBC pool"', async () => {
  const c = backedCurve(0n)
  // Busy from the first read (the pool), the second (its config) and the third (the slot) on.
  for (const from of [1, 2, 3]) {
    await assert.rejects(readLaunch(failing(c.conn, (n) => n >= from).conn, c.poolKey), (e: unknown) => {
      assert.match((e as Error).message, /the Solana RPC is busy/, `busy from read ${from}`)
      assert.doesNotMatch((e as Error).message, /no DBC pool|no DBC config/)
      return true
    })
  }
})

test('readLaunch: a migrated curve whose DAMM v2 pool cannot be read for a busy RPC is not "migrating"', async () => {
  const base = K()
  const canonical = canonicalDammPool(2, base, USDC)
  const { conn, poolKey } = await migratedLaunch([canonical], base)
  assert.equal((await readLaunch(conn, poolKey)).route, 'damm_v2')
  // Pool, config and slot answer; the DAMM v2 pool's reads are all busy.
  await assert.rejects(readLaunch(failing(conn, (n) => n >= 4).conn, poolKey), /the Solana RPC is busy/)
})

test('readLaunch: "no DBC pool" is only for an account that is not one', async () => {
  const c = backedCurve(0n)
  const DBC_ID = DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()
  await assert.rejects(readLaunch(c.conn, K()), /no DBC pool at/, 'no account')
  const swap = (v: { owner: string; data: Buffer }) => accounts(new Map([...c.map, [c.poolKey, v]]))
  await assert.rejects(
    readLaunch(swap({ owner: DBC_ID, data: c.map.get(c.configKey)!.data }), c.poolKey),
    /no DBC pool at/,
    'a DBC account of another kind',
  )
  await assert.rejects(
    readLaunch(swap({ ...c.map.get(c.poolKey)!, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }), c.poolKey),
    /no DBC pool at/,
    'another program’s account',
  )
})
