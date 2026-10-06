// A curve whose config sets enableFirstSwapWithMinFee (launchpads that bundle the creator's
// first buy). The SDK's own swap builders add the instructions sysvar for such a config; on the
// deployed programs (npm run test:meteora) nuntius's hand-built buy, which does not, lands
// anyway: the sysvar matters only to a first swap bundled with the pool's creation. So Back
// needs no refusal for these pools.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, type Connection } from '@solana/web3.js'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo as splMintTo } from '@solana/spl-token'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createKeyPairSignerFromBytes, type Address } from '@solana/kit'
import { Executor, rpcChain } from './executor.js'
import { MandateStore } from './mandate-store.js'
import { Receipts } from './receipts.js'
import { createLogger } from './log.js'
import { buildGrantTx, userAtaOf } from './mandate-chain.js'
import { backerAccountInstruction } from './launch-api.js'
import { launchPreset, meteoraConnection, readLaunch } from './meteora.js'
import { PULL_BUDGET } from './tx.js'
import { deviceSignAndSend, LOCALNET_RPC, requireLocal } from './test/localnet.js'

const skip = !LOCALNET_RPC
  ? 'LOCALNET_RPC not set'
  : process.env.LOCALNET_METEORA !== '1'
    ? 'LOCALNET_METEORA not set: run npm run test:meteora'
    : false

async function airdrop(conn: Connection, k: PublicKey) {
  await conn.confirmTransaction(await conn.requestAirdrop(k, 20 * LAMPORTS_PER_SOL), 'confirmed')
}

test(
  "a curve with enableFirstSwapWithMinFee: the executor's buy lands without the instructions sysvar",
  { skip, timeout: 600_000 },
  async () => {
    const rpc = requireLocal()
    const conn = meteoraConnection(LOCALNET_RPC)
    const [partner, creator, executorKp, backerKp] = [
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
    ]
    for (const k of [partner, creator, executorKp, backerKp]) await airdrop(conn, k.publicKey)
    const executor = await createKeyPairSignerFromBytes(executorKp.secretKey)
    const backer = await createKeyPairSignerFromBytes(backerKp.secretKey)
    const quoteMint = await createMint(conn, partner, partner.publicKey, null, 6)
    const backerQuote = await getOrCreateAssociatedTokenAccount(conn, partner, quoteMint, backerKp.publicKey)
    await splMintTo(conn, partner, quoteMint, backerQuote.address, partner, 1_000_000_000n)
    const executorQuote = (await getOrCreateAssociatedTokenAccount(conn, partner, quoteMint, executorKp.publicKey))
      .address

    const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
    const configKp = Keypair.generate()
    const params = { ...launchPreset(1_000), enableFirstSwapWithMinFee: true }
    const cfgTx = await client.partner.createConfig({
      ...params,
      config: configKp.publicKey,
      feeClaimer: partner.publicKey,
      leftoverReceiver: partner.publicKey,
      quoteMint,
      payer: partner.publicKey,
    })
    await sendAndConfirmTransaction(conn, cfgTx, [partner, configKp], { commitment: 'confirmed' })
    const baseKp = Keypair.generate()
    const poolTx = await client.creator.createPool({
      config: configKp.publicKey,
      baseMint: baseKp.publicKey,
      name: 'first swap',
      symbol: 'FIRST',
      uri: 'https://nuntius.ochinimus.app/t/proof.json',
      payer: creator.publicKey,
      poolCreator: creator.publicKey,
    })
    await sendAndConfirmTransaction(conn, poolTx, [creator, baseKp], { commitment: 'confirmed' })
    const pool = DBC.deriveDbcPoolAddress(quoteMint, baseKp.publicKey, configKp.publicKey).toBase58()
    const L = await readLaunch(conn, pool)
    assert.equal(L.swap?.route, 'dbc')

    // The backer grants one back permission (a long period: one buy is enough here).
    const baseMint = baseKp.publicKey.toBase58()
    const { ata: backerBaseAta, ix } = await backerAccountInstruction(backer.address, baseMint)
    const nowS = Math.floor(Date.now() / 1000)
    const g = await buildGrantTx(
      rpc,
      {
        owner: backer.address,
        mint: quoteMint.toBase58() as Address,
        delegatee: executor.address,
        nonce: 1n,
        amountPerPeriod: 5_000_000n,
        periodLengthS: 3_600n,
        startTs: 0n,
        expiryTs: BigInt(nowS + 7_200),
      },
      [ix],
    )
    assert.equal((await deviceSignAndSend(rpc, backer, g.transactionBase64)).err, null)

    // The executor's buy, as it runs in production, lands.
    const store = new MandateStore(new Database(':memory:'))
    const log = createLogger(() => {})
    const m = store.insertMandate(
      {
        address: backer.address,
        label: 'Back FIRST',
        payee: executor.address,
        receiverAta: executorQuote.toBase58(),
        mint: quoteMint.toBase58(),
        symbol: 'TQ',
        decimals: 6,
        amountPerPeriod: '5000000',
        pullAmount: '5000000',
        periodLengthS: 3_600,
        expiryTs: nowS + 7_200,
        nonce: 1,
        delegatee: executor.address,
        delegationPda: g.delegationPda,
        authorityPda: g.authorityPda,
        userAta: await userAtaOf(backer.address, quoteMint.toBase58() as Address),
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
      baseSymbol: 'FIRST',
      baseDecimals: 6,
      backerBaseAta,
      slippageBps: 200,
    })
    const ex = new Executor({
      store,
      chain: rpcChain(rpc, executor, PULL_BUDGET, conn),
      receipts: new Receipts(store, null, log, 'localnet'),
      log,
      settleMs: 30_000,
      random: () => 0.5,
    })
    // The jitter for an hourly period is under 6 minutes; wait it out on the program's clock.
    const start = Number(store.pullsFor(m.delegationPda)[0]?.periodStart ?? 0)
    for (let i = 0; i < 400; i++) {
      const out = await ex.tick()
      if (out[m.id] === 'landed') break
      assert.ok(['not_started'].includes(out[m.id]!), `waiting for the jitter, got ${out[m.id]} (${start})`)
      await new Promise((r) => setTimeout(r, 1_000))
    }
    const row = store.pullsFor(m.delegationPda)[0]!
    assert.equal(row.state, 'landed')
    const tx = await conn.getTransaction(row.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    const keys = tx!.transaction.message.staticAccountKeys.map((k) => k.toBase58())
    assert.ok(!keys.includes('Sysvar1nstructions1111111111111111111111111'), 'the buy carries no instructions sysvar')
    assert.equal(tx!.meta?.err, null)
    console.log(`  buy without the sysvar: ${row.signature}, ${tx!.meta?.computeUnitsConsumed} CU`)
  },
)
