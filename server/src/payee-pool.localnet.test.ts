// A Meteora pool pasted as a payee, after someone created the pool's own token account: on the
// deployed DBC program (npm run test:meteora), New permission must refuse it before the
// token-account check, for the 1.1.0 app and for v1.0.2. Every pull to such a payee would land
// where nobody can withdraw it. SKR is played by a local mint with SKR's symbol and decimals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, type Connection } from '@solana/web3.js'
import { createMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token'
import * as DBC from '@meteora-ag/dynamic-bonding-curve-sdk'
import Database from 'better-sqlite3'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { Receipts } from './receipts.js'
import { createLogger } from './log.js'
import { readAta, userAtaOf } from './mandate-chain.js'
import { launchPreset, meteoraConnection } from './meteora.js'
import { CLIENT_HEADER } from './client-version.js'
import { LOCALNET_RPC, requireLocal } from './test/localnet.js'
import type { Config } from './config.js'
import type { Address } from '@solana/kit'

const skip = !LOCALNET_RPC
  ? 'LOCALNET_RPC not set'
  : process.env.LOCALNET_METEORA !== '1'
    ? 'LOCALNET_METEORA not set: run npm run test:meteora'
    : false

const SESSION = 'P'.repeat(43)

async function airdrop(conn: Connection, k: PublicKey) {
  await conn.confirmTransaction(await conn.requestAirdrop(k, 5 * LAMPORTS_PER_SOL), 'confirmed')
}

test(
  'a pool whose token account exists is still refused as a payee, for 1.1.0 and for 1.0.2; a wallet is not',
  { skip, timeout: 300_000 },
  async () => {
    const rpc = requireLocal()
    const conn = meteoraConnection(LOCALNET_RPC)
    const [partner, creator, wallet, person] = [
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
    ]
    for (const k of [partner, creator]) await airdrop(conn, k.publicKey)
    const skr = await createMint(conn, partner, partner.publicKey, null, 6)

    // A real pool on the deployed program.
    const client = new DBC.DynamicBondingCurveClient(conn, 'confirmed')
    const config = Keypair.generate()
    const cfgTx = await client.partner.createConfig({
      ...launchPreset(1_000),
      config: config.publicKey,
      feeClaimer: partner.publicKey,
      leftoverReceiver: partner.publicKey,
      quoteMint: skr,
      payer: partner.publicKey,
    })
    await sendAndConfirmTransaction(conn, cfgTx, [partner, config], { commitment: 'confirmed' })
    const base = Keypair.generate()
    const poolTx = await client.creator.createPool({
      config: config.publicKey,
      baseMint: base.publicKey,
      name: 'payee pool',
      symbol: 'PAYEE',
      uri: 'https://nuntius.test/t/proof.json',
      payer: creator.publicKey,
      poolCreator: creator.publicKey,
    })
    await sendAndConfirmTransaction(conn, poolTx, [creator, base], { commitment: 'confirmed' })
    const pool = DBC.deriveDbcPoolAddress(skr, base.publicKey, config.publicKey)
    assert.equal((await conn.getAccountInfo(pool))?.owner.toBase58(), 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')

    // Anyone can create the pool's own SKR account; the old check (an account owned by the
    // payee, for this mint) then passes.
    await getOrCreateAssociatedTokenAccount(conn, partner, skr, pool, true)
    const poolAta = await readAta(rpc, await userAtaOf(pool.toBase58() as Address, skr.toBase58() as Address))
    assert.deepEqual([poolAta.exists, poolAta.owner, poolAta.mint], [true, pool.toBase58(), skr.toBase58()])
    // The control payee: an ordinary wallet with its SKR account; the signed-in wallet has one too.
    await getOrCreateAssociatedTokenAccount(conn, partner, skr, person.publicKey)
    await getOrCreateAssociatedTokenAccount(conn, partner, skr, wallet.publicKey)

    const db = openDb(':memory:')
    const store = new Store(db)
    store.createSession(SESSION, wallet.publicKey.toBase58(), Date.now())
    const mandates = new MandateStore(new Database(':memory:'))
    const log = createLogger(() => {})
    const app = createApp(
      { port: 0, domain: 'nuntius.test', heliusRpc: null, fcmServiceAccount: null, fcmProjectId: null } as Config,
      store,
      null,
      {
        mandates,
        cfg: {
          cluster: 'localnet',
          rpcUrl: LOCALNET_RPC,
          mints: [{ symbol: 'SKR', mint: skr.toBase58(), decimals: 6, maxPerPeriodUi: '100' }],
          maxPerPeriodUi: '100',
          delegateePath: null,
          executorIntervalMs: 60_000,
          guardIntervalMs: 60_000,
          demoEndpoints: false,
          launches: true,
          launchConfigs: {},
        },
        rpc,
        delegatee: Keypair.generate().publicKey.toBase58(),
        receipts: new Receipts(mandates, null, log, 'localnet'),
        executor: null,
        conn,
        origin: 'https://nuntius.test',
      } as never,
      { staticDir: path.join(import.meta.dirname, '..', 'static') },
    )
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base_ = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const create = async (payee: string, client?: string) => {
      const r = await fetch(`${base_}/api/mandates/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(client ? { [CLIENT_HEADER]: client } : {}) },
        body: JSON.stringify({
          session: SESSION,
          label: 'Nimus',
          payee,
          symbol: 'SKR',
          amount: '5',
          period: 'day',
          untilDays: 30,
        }),
      })
      return { status: r.status, ...((await r.json()) as { ok: boolean; error?: string; message?: string }) }
    }
    try {
      const v110 = await create(pool.toBase58(), '1.1.0')
      assert.deepEqual([v110.status, v110.error], [400, 'payee_is_pool'])
      assert.match(v110.message!, /use Back a launch/)
      const v102 = await create(pool.toBase58(), '1.0.2')
      assert.deepEqual([v102.status, v102.error], [400, 'payee_is_pool'])
      assert.equal(v102.message, 'that address is a Meteora pool, not a wallet, so it cannot be paid.')
      const ok = await create(person.publicKey.toBase58(), '1.1.0')
      assert.equal(ok.status, 200, JSON.stringify(ok))
      assert.equal(ok.ok, true)
    } finally {
      server.close()
    }
  },
)
