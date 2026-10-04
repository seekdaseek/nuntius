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
  swapInstruction,
  SWAP_INDEX,
  meteoraConnection,
} from './meteora.js'
import { fakeHelius } from './test/fake-helius.js'
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

test('the launch: preset accepted by the SDK, one transaction under 1,232 bytes, three signers', async () => {
  // The SDK reads only the quote mint's owner program while composing; answer that offline.
  const conn = {
    rpcEndpoint: 'offline',
    commitment: 'confirmed',
    getAccountInfo: async () => ({
      owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      data: Buffer.alloc(82),
      lamports: 1,
      executable: false,
    }),
  } as unknown as Connection
  const creator = K()
  const uri = `https://nuntius.ochinimus.app/m/${K()}.json`
  assert.ok(uri.length <= MAX_URI)
  const ixs = await launchInstructions(conn, {
    creator,
    quoteMint: SKR,
    quoteThreshold: 50_000,
    name: 'natXbuilder',
    symbol: 'NATX',
    uri,
    config: K(),
    baseMint: K(),
  })
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
  assert.equal(Object.keys(tx.signatures).length, 3, 'creator, config key, mint key')
  assert.ok(bytes <= 1232, `${bytes} bytes`)
  await assert.rejects(
    launchInstructions(conn, {
      creator,
      quoteMint: SKR,
      quoteThreshold: 50_000,
      name: 'x',
      symbol: 'XX',
      uri: `https://${'a'.repeat(MAX_URI)}`,
      config: K(),
      baseMint: K(),
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
