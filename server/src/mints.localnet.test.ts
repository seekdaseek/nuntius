/**
 * Two tokens side by side (the SKR path): each mint has its own beta ceiling,
 * its own Subscription Authority, and receipts carry the right symbol.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.js'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { Receipts, type PushPort } from './receipts.js'
import { Executor, rpcChain } from './executor.js'
import { createLogger } from './log.js'
import type { Config } from './config.js'
import {
  assertOk,
  ataFor,
  deviceSignAndSend,
  funded,
  LOCALNET_RPC,
  mintTo,
  requireLocal,
  skipLocalnet,
} from './test/localnet.js'

test(
  'two mints: per-mint ceilings, separate authorities, right symbols',
  { skip: skipLocalnet, timeout: 180_000 },
  async (t) => {
    const rpc = requireLocal()
    const owner = await funded(rpc)
    const delegatee = await funded(rpc)
    const payee = await funded(rpc)
    const usd = await mintTo(rpc, owner, owner.address, 10_000_000n) // 10 TUSD
    const skr = await mintTo(rpc, owner, owner.address, 5_000_000_000n) // 5000 TSKR
    await ataFor(rpc, payee, usd.mint, payee.address)
    await ataFor(rpc, payee, skr.mint, payee.address)

    const db = openDb(':memory:')
    const store = new Store(db)
    const mandates = new MandateStore(db)
    const pushes: string[] = []
    const push: PushPort = { toAddress: async (_a, m) => (pushes.push(m.title), [200]) }
    const log = createLogger(() => {})
    const receipts = new Receipts(mandates, push, log, 'localnet')
    const executor = new Executor({ store: mandates, chain: rpcChain(rpc, delegatee), receipts, log })
    const cfg = {
      cluster: 'localnet' as const,
      rpcUrl: LOCALNET_RPC,
      mints: [
        { symbol: 'TUSD', mint: usd.mint, decimals: 6, maxPerPeriodUi: '1' },
        { symbol: 'TSKR', mint: skr.mint, decimals: 6, maxPerPeriodUi: '100' },
      ],
      maxPerPeriodUi: '100',
      delegateePath: null,
      executorIntervalMs: 30_000,
      guardIntervalMs: 60_000,
      demoEndpoints: false,
    }
    const config = {
      port: 0,
      domain: 'localhost',
      heliusRpc: null,
      fcmServiceAccount: null,
      fcmProjectId: null,
    } as unknown as Config
    const app = createApp(config, store, null, undefined, {
      mandates,
      cfg,
      rpc,
      delegatee: delegatee.address,
      receipts,
      executor,
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    t.after(() => server.close())
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const session = 'M'.repeat(40) + 'int'
    store.createSession(session, owner.address, Date.now())
    store.claimSgtMint(session, 'SimulatedSgt1111111111111111111111111111111')
    const call = async (p: string, body: Record<string, unknown>) => {
      const r = await fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, ...body }),
      })
      return { status: r.status, json: (await r.json()) as Record<string, any> }
    }
    const terms = { label: 'Club', payee: payee.address, period: 'week', untilDays: 30 }

    await t.test('each mint has its own ceiling', async () => {
      assert.equal(
        (await call('/api/mandates/preview', { ...terms, symbol: 'TUSD', amount: '2' })).json.error,
        'over_beta_ceiling',
      )
      assert.equal((await call('/api/mandates/preview', { ...terms, symbol: 'TSKR', amount: '50' })).status, 200)
      assert.equal(
        (await call('/api/mandates/preview', { ...terms, symbol: 'TSKR', amount: '101' })).json.error,
        'over_beta_ceiling',
      )
      assert.equal(
        (await call('/api/mandates/preview', { ...terms, symbol: 'NOPE', amount: '1' })).json.error,
        'bad_mint',
      )
    })

    await t.test(
      'grant in each mint with one signature; the executor pulls both; receipts carry the symbol',
      async () => {
        for (const [symbol, amount] of [
          ['TUSD', '0.5'],
          ['TSKR', '50'],
        ] as const) {
          const c = await call('/api/mandates/create', { ...terms, label: `Club ${symbol}`, symbol, amount })
          assert.equal(c.status, 200, JSON.stringify(c.json))
          assert.equal(c.json.createsAuthority, true, `${symbol}: its own authority`)
          assertOk(await deviceSignAndSend(rpc, owner, c.json.transactionBase64))
          assert.equal((await call('/api/mandates/confirm', { mandateId: c.json.mandateId })).status, 200)
        }
        const outcomes = Object.values(await executor.tick())
        assert.deepEqual(outcomes, ['landed', 'landed'])
        const l = await call('/api/mandates/list', {})
        assert.deepEqual(l.json.mints, ['TUSD', 'TSKR'])
        assert.deepEqual(new Set(l.json.mine.map((m: { symbol: string }) => m.symbol)), new Set(['TUSD', 'TSKR']))
        assert.equal(l.json.tokenAccounts.length, 2)
        assert.ok(
          l.json.tokenAccounts.every((a: { delegate: string | null }) => a.delegate),
          'both token accounts delegated',
        )
        const rc = await call('/api/receipts', {})
        const pulls = rc.json.receipts.filter((r: { kind: string }) => r.kind === 'pull')
        assert.deepEqual(
          new Set(pulls.map((r: { amount: string; symbol: string }) => `${r.amount} ${r.symbol}`)),
          new Set(['0.5 TUSD', '50 TSKR']),
        )
        assert.ok(pushes.includes('Club TSKR received 50 TSKR'))
        const w = await call('/api/widget', { tzOffsetMin: 0 })
        assert.deepEqual(new Set(w.json.rows.map((r: { symbol: string }) => r.symbol)), new Set(['TUSD', 'TSKR']))
      },
    )
  },
)
