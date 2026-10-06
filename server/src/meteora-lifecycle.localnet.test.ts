// The subscription-launch lifecycle on Meteora's programs as deployed on mainnet, cloned into a
// local validator (scripts/localnet.sh --meteora): config, pool, three backers, executor buys
// over several periods, a trader pushing the curve to its end, the last buy cut to the room
// left, the race at completion, a decoy DAMM v2 pool, the migration crank, the first buy on
// DAMM v2, and a revoke. Every buy asserts the custody invariant. The run writes its
// signatures, compute units, sizes and balances to METEORA_RESULTS (npm run test:meteora).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import BN from 'bn.js'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, type Connection } from '@solana/web3.js'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo as splMintTo } from '@solana/spl-token'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import * as CPAMM from '@meteora-ag/cp-amm-sdk'
import { createKeyPairSignerFromBytes, type Address, type Instruction, type KeyPairSigner } from '@solana/kit'
import { Executor, rpcChain, type ChainPort, type PreparedBuy } from './executor.js'
import { MandateStore, type Backing, type Mandate } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { createLogger } from './log.js'
import { buildGrantTx, buildRevokeTx, pullInstruction, userAtaOf } from './mandate-chain.js'
import { backerAccountInstruction } from './launch-api.js'
import {
  canonicalDammPool,
  configInstructions,
  DBC_PROGRAM,
  DAMM_V2_PROGRAM,
  launchInstructions,
  meteoraConnection,
  readLaunch,
} from './meteora.js'
import { PULL_BUDGET, type Rpc } from './tx.js'
import { deviceSignAndSend, LOCALNET_RPC, requireLocal, signAndLand, sleep, tokenBalance } from './test/localnet.js'

const skipMeteora = !LOCALNET_RPC
  ? 'LOCALNET_RPC not set'
  : process.env.LOCALNET_METEORA !== '1'
    ? 'LOCALNET_METEORA not set: run npm run test:meteora (Meteora programs cloned from mainnet)'
    : false

const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
const DECIMALS = 6
const unit = (ui: number) => BigInt(Math.round(ui * 10 ** DECIMALS))
/** The backers' period: under 20 s the send jitter is 0 (buyJitterS: a tenth of the period). */
const PERIOD_S = 15
/** The curve under test migrates at this much quote raised: small, so a test fills it. */
const THRESHOLD_UI = 100
const PER_PERIOD = unit(3)

type Row = Record<string, unknown>
const results: { ranAt: string; validator: Row; programs: Row[]; steps: Row[] } = {
  ranAt: new Date().toISOString(),
  validator: {},
  programs: [],
  steps: [],
}
const step = (name: string, data: Row) => {
  results.steps.push({ step: name, ...data })
  console.log(`  ${name}: ${JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
}

/**
 * The deployed program's ELF as cloned: its upgrade authority and sha256. (The test validator
 * rewrites the deploy slot in the header on clone, so it is not recorded.)
 */
async function programFacts(conn: Connection, program: string): Promise<Row> {
  const acc = await conn.getAccountInfo(new PublicKey(program))
  assert.ok(acc?.executable, `${program} is executable on this validator`)
  const programData = new PublicKey(acc!.data.subarray(4, 36))
  const pd = await conn.getAccountInfo(programData)
  const d = pd!.data
  const authority = d[12] === 1 ? new PublicKey(d.subarray(13, 45)).toBase58() : null
  let end = d.length
  while (end > 45 && d[end - 1] === 0) end--
  const elf = d.subarray(45, end)
  return {
    program,
    programData: programData.toBase58(),
    upgradeAuthority: authority,
    elfBytes: elf.length,
    elfSha256: createHash('sha256').update(elf).digest('hex'),
  }
}

async function airdrop(conn: Connection, k: PublicKey, sol = 20) {
  const s = await conn.requestAirdrop(k, sol * LAMPORTS_PER_SOL)
  await conn.confirmTransaction(s, 'confirmed')
}

/** What a landed transaction cost in compute and bytes, and who signed it. */
interface TxFacts extends Row {
  signature: string
  err: unknown
  computeUnits: number | null
  bytes: number
  feeLamports: number | null
  signers: string[]
}
async function txFacts(conn: Connection, sig: string): Promise<TxFacts> {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  assert.ok(tx, `transaction ${sig} is on the ledger`)
  const keys = tx!.transaction.message.staticAccountKeys
  const signers = keys.slice(0, tx!.transaction.message.header.numRequiredSignatures).map((k) => k.toBase58())
  return {
    signature: sig,
    err: tx!.meta?.err ?? null,
    computeUnits: tx!.meta?.computeUnitsConsumed ?? null,
    // The wire size: the signature count (one byte), the signatures, then the message.
    bytes: 1 + 64 * signers.length + tx!.transaction.message.serialize().length,
    feeLamports: tx!.meta?.fee ?? null,
    signers,
  }
}

const ataBalance = async (rpc: Rpc, ata: string): Promise<bigint | null> => {
  const a = await rpc.getAccountInfo(ata as Address, { encoding: 'base64' }).send()
  return a.value ? tokenBalance(rpc, ata as Address) : null
}

test(
  'the subscription-launch lifecycle on the deployed DBC and DAMM v2 programs',
  { skip: skipMeteora, timeout: 900_000 },
  async () => {
    const rpc = requireLocal()
    const conn = meteoraConnection(LOCALNET_RPC)
    results.validator = { rpc: LOCALNET_RPC, slotAtStart: await conn.getSlot('confirmed') }
    for (const p of [DBC_PROGRAM, DAMM_V2_PROGRAM, METAPLEX]) results.programs.push(await programFacts(conn, p))

    // --- Actors ------------------------------------------------------------------------------
    const partner = Keypair.generate() // the config's fee claimer: nuntius in production
    const creator = Keypair.generate() // the builder who launches
    const trader = Keypair.generate() // anyone else on the curve
    const executorKp = Keypair.generate()
    const backerKps = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
    for (const k of [partner, creator, trader, executorKp, ...backerKps]) await airdrop(conn, k.publicKey)
    const executor: KeyPairSigner = await createKeyPairSignerFromBytes(executorKp.secretKey)
    const backers = await Promise.all(backerKps.map((k) => createKeyPairSignerFromBytes(k.secretKey)))

    // A quote token standing in for SKR or USDC: classic SPL Token, 6 decimals.
    const quoteMint = await createMint(conn, partner, partner.publicKey, null, DECIMALS)
    const fundQuote = async (owner: PublicKey, amount: bigint) => {
      const ata = await getOrCreateAssociatedTokenAccount(conn, partner, quoteMint, owner)
      await splMintTo(conn, partner, quoteMint, ata.address, partner, amount)
      return ata.address
    }
    for (const b of backerKps) await fundQuote(b.publicKey, unit(1_000))
    await fundQuote(trader.publicKey, unit(1_000))
    // The executor's own quote account: each buy's pull lands there and its swap empties it.
    const executorQuote = (await getOrCreateAssociatedTokenAccount(conn, partner, quoteMint, executorKp.publicKey))
      .address

    // --- 1. The config under test, then the pool: the server's own composition ----------------
    // configInstructions is what tools/launch-config.ts sends once per quote mint; the pool is
    // launchInstructions on it, as /api/launch/create builds it for the device.
    const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
    const signersOf = async (...kps: Keypair[]) =>
      new Map(
        await Promise.all(
          kps.map(async (k) => [k.publicKey.toBase58(), await createKeyPairSignerFromBytes(k.secretKey)] as const),
        ),
      )
    const withSigners = (ixs: Instruction[], signers: Map<string, KeyPairSigner>) =>
      ixs.map((ix) => ({
        ...ix,
        accounts: ix.accounts?.map((a) => (signers.has(a.address) ? { ...a, signer: signers.get(a.address)! } : a)),
      })) as Instruction[]
    const configKp = Keypair.generate()
    const partnerSigners = await signersOf(partner, configKp)
    const cfgIxs = await configInstructions(conn, {
      config: configKp.publicKey.toBase58(),
      feeClaimer: partner.publicKey.toBase58(),
      leftoverReceiver: partner.publicKey.toBase58(),
      quoteMint: quoteMint.toBase58(),
      payer: partner.publicKey.toBase58(),
      quoteThreshold: THRESHOLD_UI,
    })
    const partnerBefore = await conn.getBalance(partner.publicKey, 'confirmed')
    const cfgLanded = await signAndLand(
      rpc,
      partnerSigners.get(partner.publicKey.toBase58())!,
      withSigners(cfgIxs, partnerSigners),
    )
    assert.equal(cfgLanded.err, null, `config: ${cfgLanded.err}`)
    const cfgCost = partnerBefore - (await conn.getBalance(partner.publicKey, 'confirmed'))
    const cfgState = (await client.state.getPoolConfig(configKp.publicKey))!
    assert.equal(cfgState.feeClaimer.toBase58(), partner.publicKey.toBase58(), 'the fee claimer is the partner')
    assert.equal(Number(cfgState.migrationFeeOption), 2)
    assert.equal(Number(cfgState.creatorTradingFeePercentage), 50)
    step('1a create config (the payer pays its rent)', {
      config: configKp.publicKey.toBase58(),
      ...(await txFacts(conn, cfgLanded.signature)),
      payerCostLamports: cfgCost,
    })
    const baseKp = Keypair.generate()
    const creatorSigners = await signersOf(creator, baseKp)
    const poolIxs = await launchInstructions(conn, {
      creator: creator.publicKey.toBase58(),
      config: configKp.publicKey.toBase58(),
      name: 'nuntius proof',
      symbol: 'PROOF',
      uri: 'https://nuntius.ochinimus.app/m/proof.json',
      baseMint: baseKp.publicKey.toBase58(),
    })
    const creatorBefore = await conn.getBalance(creator.publicKey, 'confirmed')
    const poolLanded = await signAndLand(
      rpc,
      creatorSigners.get(creator.publicKey.toBase58())!,
      withSigners(poolIxs, creatorSigners),
    )
    assert.equal(poolLanded.err, null, `pool: ${poolLanded.err}`)
    const poolCost = creatorBefore - (await conn.getBalance(creator.publicKey, 'confirmed'))
    const pool = DBC.deriveDbcPoolAddress(quoteMint, baseKp.publicKey, configKp.publicKey).toBase58()
    const baseMint = baseKp.publicKey.toBase58()
    const poolFacts = await txFacts(conn, poolLanded.signature)
    assert.deepEqual(
      poolFacts.signers.sort(),
      [creator.publicKey.toBase58(), baseMint].sort(),
      'the creator and the mint key',
    )
    step('1b create pool on the config (the creator signs once; the mint key is fresh)', {
      pool,
      baseMint,
      ...poolFacts,
      creatorCostLamports: poolCost,
    })
    const L0 = await readLaunch(conn, pool)
    assert.equal(L0.route, 'dbc')
    assert.equal(L0.refusal, null, 'the preset is a pool Back can buy')
    const executorBase = await userAtaOf(executor.address, baseMint as Address)

    // --- 2. Three backers grant back permissions, one Seed Vault signature each ---------------
    const store = new MandateStore(new Database(':memory:'))
    const pushes: { title: string; body: string; url: string }[] = []
    const push: PushPort = { toAddress: async (_a, msg) => (pushes.push(msg), [200]) }
    const lines: string[] = []
    const log = createLogger((l) => lines.push(l))
    const receipts = new Receipts(store, push, log, 'localnet')
    const mandates: Mandate[] = []
    for (const [i, owner] of backers.entries()) {
      const { ata: backerBaseAta, ix } = await backerAccountInstruction(owner.address, baseMint)
      const nowS = Math.floor(Date.now() / 1000)
      const g = await buildGrantTx(
        rpc,
        {
          owner: owner.address,
          mint: quoteMint.toBase58() as Address,
          delegatee: executor.address,
          nonce: BigInt(i + 1),
          amountPerPeriod: PER_PERIOD,
          periodLengthS: BigInt(PERIOD_S),
          startTs: 0n,
          expiryTs: BigInt(nowS + 3_600),
        },
        [ix],
      )
      const landed = await deviceSignAndSend(rpc, owner, g.transactionBase64)
      assert.equal(landed.err, null, `grant ${i}: ${landed.err}`)
      const m = store.insertMandate(
        {
          address: owner.address,
          label: `Back PROOF ${i + 1}`,
          payee: executor.address,
          receiverAta: executorQuote.toBase58(),
          mint: quoteMint.toBase58(),
          symbol: 'TQ',
          decimals: DECIMALS,
          amountPerPeriod: PER_PERIOD.toString(),
          pullAmount: PER_PERIOD.toString(),
          periodLengthS: PERIOD_S,
          expiryTs: nowS + 3_600,
          nonce: i + 1,
          delegatee: executor.address,
          delegationPda: g.delegationPda,
          authorityPda: g.authorityPda,
          userAta: await userAtaOf(owner.address, quoteMint.toBase58() as Address),
        },
        Date.now(),
      )
      store.setStatus(m.id, 'active', Date.now())
      store.setBacking({
        mandateId: m.id,
        pool,
        route: 'dbc',
        dammPool: null,
        baseMint,
        baseSymbol: 'PROOF',
        baseDecimals: DECIMALS,
        backerBaseAta,
        slippageBps: 200,
      })
      mandates.push(store.getMandate(m.id)!)
      step(`2 grant, backer ${i + 1}`, { ...(await txFacts(conn, landed.signature)), backerBaseAta })
    }

    // The race at completion (step 5) needs one buy built before the curve completes and sent
    // after. This chain port hands the executor such a stale buy, once, for one mandate.
    const real = rpcChain(rpc, executor, PULL_BUDGET, conn)
    const stale = new Map<string, PreparedBuy>()
    const chain: ChainPort = {
      ...real,
      async prepareBuy(m: Mandate, b: Backing, amount: bigint) {
        const s = stale.get(m.id)
        if (s) {
          stale.delete(m.id)
          return s
        }
        return real.prepareBuy!(m, b, amount)
      },
    }
    const ex = new Executor({
      store,
      chain,
      receipts,
      log,
      settleMs: 30_000,
      random: () => 0.5,
      migrateAfterMs: 0,
      migrationBudgetLamports: 100_000_000n,
      floorLamports: 1_000_000n,
    })

    /** One tick, with the custody invariant and the receipt checked for every buy that landed. */
    const tickAndCheck = async (label: string) => {
      const quoteBefore = await tokenBalance(rpc, executorQuote.toBase58() as Address)
      const baseBefore = await ataBalance(rpc, executorBase)
      const backerBefore = await Promise.all(mandates.map((m) => ataBalance(rpc, store.backingOf(m.id)!.backerBaseAta)))
      const out = await ex.tick()
      const quoteAfter = await tokenBalance(rpc, executorQuote.toBase58() as Address)
      const baseAfter = await ataBalance(rpc, executorBase)
      assert.equal(quoteAfter, quoteBefore, `${label}: the executor's quote balance is the same after as before`)
      assert.equal(quoteAfter, 0n, `${label}: the executor holds no quote`)
      assert.equal(baseAfter, baseBefore, `${label}: the executor never holds the launch token`)
      for (const [i, m] of mandates.entries()) {
        if (out[m.id] !== 'landed') continue
        const row = store.pullsFor(m.delegationPda).at(-1)!
        const after = await ataBalance(rpc, store.backingOf(m.id)!.backerBaseAta)
        const got = (after ?? 0n) - (backerBefore[i] ?? 0n)
        assert.ok(got > 0n, `${label}: backer ${i + 1} received the token`)
        const e = store.events(m.address).find((x) => x.signature === row.signature)!
        assert.equal(e.kind, 'buy')
        assert.equal(e.outBaseUnits, got.toString(), 'the receipt says what landed in the backer’s account')
        const facts = await txFacts(conn, row.signature)
        assert.deepEqual(facts.signers, [executor.address], 'one signer: the executor')
        step(`${label}, backer ${i + 1}`, {
          ...facts,
          route: store.backingOf(m.id)!.route,
          pool: store.backingOf(m.id)!.dammPool ?? pool,
          quoteIn: row.amount,
          baseOut: got.toString(),
          executorQuote: { before: quoteBefore.toString(), after: quoteAfter.toString() },
          executorBase: { before: baseBefore?.toString() ?? 'none', after: baseAfter?.toString() ?? 'none' },
        })
      }
      return out
    }
    /** Waits until the program's clock has opened the next period for every backer. */
    const nextPeriod = async () => {
      const due = mandates.reduce((mx, m) => {
        const end = BigInt(store.pullsFor(m.delegationPda).at(-1)?.periodStart ?? 0) + BigInt(PERIOD_S)
        return end > mx ? end : mx
      }, 0n)
      while ((await real.clock!()) < due) await sleep(500)
    }

    // --- 3. Several periods of buys ------------------------------------------------------------
    for (let p = 1; p <= 2; p++) {
      const out = await tickAndCheck(`3 period ${p} buy`)
      for (const m of mandates) assert.equal(out[m.id], 'landed', `period ${p}: ${m.label} bought`)
      await nextPeriod()
    }

    // --- 4. A trader pushes the curve near its end; a decoy DAMM v2 pool appears --------------
    const before4 = await readLaunch(conn, pool)
    const room = BigInt(before4.threshold) - BigInt(before4.quoteRaised)
    // Leave less room than one period's buy, so the next buy must be cut to fit.
    const traderIn = ((room - PER_PERIOD / 2n) * 100n) / 99n
    const swapTx = await client.pool.swap({
      owner: trader.publicKey,
      pool: new PublicKey(pool),
      amountIn: new BN(traderIn.toString()),
      minimumAmountOut: new BN(0),
      swapBaseForQuote: false,
      referralTokenAccount: null,
    })
    const swapSig = await sendAndConfirmTransaction(conn, swapTx, [trader], { commitment: 'confirmed' })
    const after4 = await readLaunch(conn, pool)
    const roomLeft = BigInt(after4.threshold) - BigInt(after4.quoteRaised)
    assert.ok(roomLeft > 0n && roomLeft < PER_PERIOD, `room left ${roomLeft} is under one buy (${PER_PERIOD})`)
    step('4a trader pushes the curve', {
      ...(await txFacts(conn, swapSig)),
      quoteIn: traderIn.toString(),
      roomLeft: roomLeft.toString(),
    })

    // The decoy: a DAMM v2 pool for the same pair, opened by the trader before migration.
    const amm = new CPAMM.CpAmm(conn)
    const traderBase = await getOrCreateAssociatedTokenAccount(conn, trader, baseKp.publicKey, trader.publicKey)
    const decoyBase = new BN((traderBase.amount / 1000n).toString())
    const decoyQuote = new BN(unit(1).toString())
    const prep = amm.preparePoolCreationParams({
      tokenAAmount: decoyBase,
      tokenBAmount: decoyQuote,
      minSqrtPrice: CPAMM.MIN_SQRT_PRICE,
      maxSqrtPrice: CPAMM.MAX_SQRT_PRICE,
      collectFeeMode: 0,
    })
    const decoyNft = Keypair.generate()
    const decoy = await amm.createCustomPool({
      payer: trader.publicKey,
      creator: trader.publicKey,
      positionNft: decoyNft.publicKey,
      tokenAMint: baseKp.publicKey,
      tokenBMint: quoteMint,
      tokenAAmount: decoyBase,
      tokenBAmount: decoyQuote,
      sqrtMinPrice: CPAMM.MIN_SQRT_PRICE,
      sqrtMaxPrice: CPAMM.MAX_SQRT_PRICE,
      liquidityDelta: prep.liquidityDelta,
      initSqrtPrice: prep.initSqrtPrice,
      poolFees: {
        baseFee: CPAMM.getBaseFeeParams({
          baseFeeMode: CPAMM.BaseFeeMode.FeeTimeSchedulerLinear,
          feeTimeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
        }),
        compoundingFeeBps: 0,
        padding: 0,
        dynamicFee: null,
      },
      hasAlphaVault: false,
      activationType: 1,
      collectFeeMode: 0,
      activationPoint: null,
      tokenAProgram: CPAMM.getTokenProgram(0),
      tokenBProgram: CPAMM.getTokenProgram(0),
    })
    const decoySig = await sendAndConfirmTransaction(conn, decoy.tx, [trader, decoyNft], { commitment: 'confirmed' })
    const canonical = canonicalDammPool(2, baseMint, quoteMint.toBase58())
    assert.notEqual(decoy.pool.toBase58(), canonical)
    step('4b decoy DAMM v2 pool for the same pair', {
      decoy: decoy.pool.toBase58(),
      canonical,
      ...(await txFacts(conn, decoySig)),
    })

    // --- 5. The last buy is cut to the room left; the race; the executor waits --------------
    await nextPeriod()
    const [first, second, third] = mandates as [Mandate, Mandate, Mandate]
    // Backer 2's buy is built now, while the curve is open, and handed over after backer 1
    // has completed it: the race at completion.
    const built = await real.prepareBuy!(second, store.backingOf(second.id)!, PER_PERIOD)
    assert.equal(built.kind, 'buy')
    stale.set(second.id, built)
    const out5 = await tickAndCheck('5a last buy on the curve')
    assert.equal(out5[first.id], 'landed', 'the buy cut to the room left lands')
    const lastRow = store.pullsFor(first.delegationPda).at(-1)!
    assert.ok(BigInt(lastRow.amount) < PER_PERIOD, `cut to ${lastRow.amount}, under ${PER_PERIOD}`)
    assert.ok(!lines.some((l) => l.includes('executor_buy_no_room')), 'no 6033: the cut fits')
    const s2 = store.pullsFor(second.delegationPda).at(-1)!
    assert.equal(out5[second.id], 'skipped', 'the stale buy is skipped')
    const e2 = store.events(second.address).find((e) => e.kind === 'skipped')!
    assert.ok(e2.note === 'curve_full' || e2.note === 'no_room', `named by its cause: ${e2.note}`)
    assert.doesNotMatch(pushes.find((x) => x.url.includes('kind=skipped'))!.body, /price moved/)
    step('5b the race: a buy built before completion, simulated after', {
      errorCode: s2.errorCode,
      pullState: s2.error,
      receipt: e2.note,
    })
    assert.equal(out5[third.id], 'buy_waiting', 'while it migrates the executor sends nothing')
    assert.equal(store.pullsFor(third.delegationPda).length, 2, 'no ledger row for the waiting period')

    // --- 6. The crank migrates the curve to its canonical DAMM v2 pool -----------------------
    const mig = store.migrationOf(pool)
    assert.ok(mig, `the crank ran in the same tick: ${JSON.stringify(out5)}`)
    assert.equal(mig!.state, 'landed', JSON.stringify(mig))
    assert.equal(mig!.dammPool, canonical)
    const migFacts = await txFacts(conn, mig!.signature!)
    assert.deepEqual(migFacts.signers.slice(0, 1), [executor.address], 'the executor pays for the migration')
    step('6 migration by the crank', { ...migFacts, dammPool: canonical, costLamports: mig!.costLamports })
    const migrated = await readLaunch(conn, pool)
    assert.equal(migrated.route, 'damm_v2')
    assert.equal(migrated.dammPool, canonical, 'the canonical pool, not the decoy')
    assert.ok(pushes.some((x) => x.title === 'PROOF moved to its regular pool'))

    // --- 6b. The same period, after the migration: the buy that lost the race and the one that
    // waited both go through, on the canonical DAMM v2 pool; backer 1's period is already done.
    const raceStart = BigInt(store.pullsFor(second.delegationPda).at(-1)!.periodStart)
    const left = raceStart + BigInt(PERIOD_S) - (await real.clock!())
    assert.ok(left > 1n, `still inside the race's period (${left} s left), so this is the same period`)
    const out6 = await tickAndCheck('6b same period, after migration')
    assert.equal(out6[first.id], 'period_done')
    assert.equal(out6[second.id], 'landed', 'the buy that lost the race buys on DAMM v2 in the same period')
    assert.equal(out6[third.id], 'landed', 'the buy that waited buys on DAMM v2 in the same period')
    const retried = store.pullsFor(second.delegationPda).at(-1)!
    assert.equal(BigInt(retried.periodStart), raceStart, 'the same ledger row: one per delegation and period')
    assert.equal(retried.attempts, 2)
    assert.equal(retried.state, 'landed')
    for (const m of [second, third]) assert.equal(store.backingOf(m.id)!.dammPool, canonical)

    // --- 7. The next buy goes to the canonical DAMM v2 pool ----------------------------------
    await nextPeriod()
    const out7 = await tickAndCheck('7 first buy on DAMM v2')
    for (const m of mandates) {
      assert.equal(out7[m.id], 'landed', `${m.label} bought on DAMM v2`)
      assert.equal(store.backingOf(m.id)!.route, 'damm_v2')
      assert.equal(store.backingOf(m.id)!.dammPool, canonical)
    }

    // --- 8. A revoke, and the next pull dies ------------------------------------------------
    const rv = await buildRevokeTx(
      rpc,
      first.address as Address,
      first.delegationPda as Address,
      quoteMint.toBase58() as Address,
    )
    const rvLanded = await deviceSignAndSend(rpc, backers[0]!, rv.transactionBase64)
    assert.equal(rvLanded.err, null)
    step('8a revoke', await txFacts(conn, rvLanded.signature))
    await nextPeriod()
    const out8 = await ex.tick()
    assert.equal(out8[first.id], 'revoked', 'the executor sees the delegation gone and ends the permission')
    const dead = await signAndLand(rpc, executor, [
      await pullInstruction({
        delegatee: executor,
        delegationPda: first.delegationPda as Address,
        delegator: first.address as Address,
        delegatorAta: first.userAta as Address,
        receiverAta: executorQuote.toBase58() as Address,
        mint: quoteMint.toBase58() as Address,
        amount: 1n,
      }),
    ])
    assert.ok(dead.err, 'a pull after the revoke fails on chain')
    step('8b a pull after the revoke', { signature: dead.signature, err: dead.err })

    results.validator = { ...results.validator, slotAtEnd: await conn.getSlot('confirmed') }
    if (process.env.METEORA_RESULTS)
      writeFileSync(
        process.env.METEORA_RESULTS,
        `${JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
      )
  },
)
