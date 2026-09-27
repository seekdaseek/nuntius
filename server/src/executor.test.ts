import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { Executor } from './executor.js'
import { MandateStore, type Mandate } from './mandate-store.js'
import { Receipts, receiptMessage, type PushPort } from './receipts.js'
import { createLogger } from './log.js'
import { FakeChain } from './test/fake-chain.js'

const PDA = 'PdaDeLegation1111111111111111111111111111111'
const DELEGATEE = 'DeLegatee1111111111111111111111111111111111'
const OWNER = 'Owner11111111111111111111111111111111111111'

function setup(overrides: Partial<{ amountPerPeriod: bigint; pullAmount: string; expiry: bigint }> = {}) {
  const chain = new FakeChain()
  const store = new MandateStore(new Database(':memory:'))
  const pushes: { address: string; title: string; body: string; url: string }[] = []
  const push: PushPort = {
    async toAddress(address, msg) {
      pushes.push({ address, ...msg })
      return [200]
    },
  }
  const lines: string[] = []
  const log = createLogger((l) => lines.push(l))
  const receipts = new Receipts(store, push, log, 'localnet')
  let nowMs = Number(chain.nowS) * 1000
  const clock = {
    now: () => nowMs,
    advance(s: number) {
      nowMs += s * 1000
      chain.nowS += BigInt(s)
    },
  }
  const cap = overrides.amountPerPeriod ?? 10_000n
  chain.add(PDA, {
    delegatee: DELEGATEE,
    delegator: OWNER,
    mint: 'Mint',
    amountPerPeriod: cap,
    periodStart: chain.nowS,
    periodLength: 60n,
    expiry: overrides.expiry ?? 0n,
  })
  const m = store.insertMandate(
    {
      address: OWNER,
      label: 'Rent',
      payee: 'Payee',
      receiverAta: 'ReceiverAta',
      mint: 'Mint',
      symbol: 'USDC',
      decimals: 6,
      amountPerPeriod: cap.toString(),
      pullAmount: overrides.pullAmount ?? cap.toString(),
      periodLengthS: 60,
      expiryTs: Number(overrides.expiry ?? 0n),
      nonce: 0,
      delegatee: DELEGATEE,
      delegationPda: PDA,
      authorityPda: 'Auth',
      userAta: 'UserAta',
    },
    nowMs,
  )
  store.setStatus(m.id, 'active', nowMs)
  const mk = (extra: object = {}) =>
    new Executor({
      store,
      chain,
      receipts,
      log,
      now: clock.now,
      settleMs: 0,
      sleep: async () => {},
      random: () => 1,
      ...extra,
    })
  return { chain, store, pushes, lines, clock, m: store.getMandate(m.id)! as Mandate, mk }
}

test('pulls exactly once per period and again after the roll', async () => {
  const { chain, store, pushes, clock, m, mk } = setup()
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
  assert.equal(chain.sent.length, 1, 'one transfer in the period, however many ticks')
  clock.advance(61)
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  assert.equal(chain.sent.length, 2)
  assert.equal(store.pullsFor(PDA).length, 2)
  assert.equal(pushes.length, 2)
  assert.equal(pushes[0]!.title, 'Rent received 0.01 USDC')
  assert.match(pushes[0]!.body, /^0 of 0.01 USDC left this period/)
  assert.match(pushes[0]!.url, /sig=sig1/)
})

test('a lost transaction is replaced only after its blockhash is dead — never doubled', async () => {
  const { chain, store, clock, m, mk } = setup()
  chain.sendDrops = 1
  assert.deepEqual(await mk().tick(), { [m.id]: 'sent_pending' })
  // A restart: a brand-new executor with no memory must not build a second transfer.
  assert.deepEqual(await mk().tick(), { [m.id]: 'sent_pending' })
  assert.equal(chain.sent.length, 0)
  chain.height += 151n // the first attempt's blockhash can no longer land
  clock.advance(1)
  assert.deepEqual(await mk().tick(), { [m.id]: 'landed' })
  const rows = store.pullsFor(PDA)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.attempts, 2)
  assert.equal(rows[0]!.state, 'landed')
  assert.equal(chain.sent.length, 1, 'exactly one transfer landed')
})

test('a send that throws after the transfer landed is recovered from the chain, not re-sent', async () => {
  const { chain, store, m, mk } = setup()
  chain.sendThrowsAfterApply = 1
  assert.deepEqual(await mk().tick(), { [m.id]: 'error' })
  assert.equal(chain.sent.length, 1)
  const ex = mk() // restart
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  assert.equal(chain.sent.length, 1, 'no second transfer')
  assert.equal(store.pullsFor(PDA)[0]!.state, 'landed')
})

test('gives up after maxAttempts expired transactions for one period', async () => {
  const { chain, store, m, mk } = setup()
  chain.sendDrops = 99
  const ex = mk({ maxAttempts: 3 })
  await ex.tick()
  for (let i = 0; i < 3; i++) {
    chain.height += 151n
    await ex.tick()
  }
  const row = store.pullsFor(PDA)[0]!
  assert.equal(row.state, 'failed')
  assert.equal(row.error, 'expired_max_attempts')
  assert.equal(row.attempts, 3)
})

test('0x190: a refusal is recorded, pushed once, and never retried', async () => {
  const { chain, store, pushes, m, mk } = setup()
  // Something consumes part of the cap between our read and our send.
  chain.beforeApply = (pda) => {
    chain.delegations.get(pda)!.pulled += 1n
    chain.beforeApply = null
  }
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'refused' })
  assert.equal(store.pullsFor(PDA)[0]!.state, 'refused')
  assert.equal(store.pullsFor(PDA)[0]!.errorCode, 400)
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
  const refused = store.events(OWNER).filter((e) => e.kind === 'refused')
  assert.equal(refused.length, 1)
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0]!.title, 'Refused by the chain: Rent')
  assert.match(pushes[0]!.body, /0x190/)
})

test('revoked outside the executor: mandate ends with one receipt and is left alone', async () => {
  const { chain, store, pushes, m, mk } = setup()
  chain.delegations.delete(PDA)
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'revoked' })
  assert.equal(store.getMandate(m.id)!.status, 'revoked')
  assert.deepEqual(await ex.tick(), {}, 'no longer active')
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0]!.title, 'Revoked: Rent')
  assert.doesNotMatch(pushes[0]!.url, /sig=/, 'no fake signature in an explorer link')
})

test('expiry ends the mandate; nothing is sent after it', async () => {
  const { chain, store, clock, m, mk } = setup({ expiry: 1_000_030n })
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  clock.advance(40)
  assert.deepEqual(await ex.tick(), { [m.id]: 'expired' })
  assert.equal(store.getMandate(m.id)!.status, 'expired')
  assert.equal(chain.sent.length, 1)
})

test('RPC failure backs off exponentially with jitter, then recovers; logs carry no secret', async () => {
  const { chain, lines, clock, m, mk } = setup()
  const ex = mk({ backoffBaseMs: 1_000, random: () => 1 })
  chain.readFailures = 2
  assert.deepEqual(await ex.tick(), { [m.id]: 'error' })
  assert.equal(ex.backoffOf(m.id)!.failures, 1)
  assert.deepEqual(await ex.tick(), { [m.id]: 'skipped_backoff' })
  clock.advance(1)
  assert.deepEqual(await ex.tick(), { [m.id]: 'error' })
  const b = ex.backoffOf(m.id)!
  assert.equal(b.failures, 2)
  assert.equal(b.nextAt - clock.now(), 2_000, 'doubled')
  clock.advance(2)
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  assert.equal(ex.backoffOf(m.id), undefined, 'reset on success')
  assert.ok(lines.some((l) => l.includes('executor_backoff')))
  for (const l of lines) assert.doesNotMatch(l, /SUPERSECRET/)
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), 'every log line is JSON')
})

test('an invalid receiver sends nothing', async () => {
  const { chain, store, m, mk } = setup()
  chain.receiverValid = false
  assert.deepEqual(await mk().tick(), { [m.id]: 'error' })
  assert.equal(chain.sent.length, 0)
  assert.equal(store.pullsFor(PDA).length, 0)
})

test('cap already used in this period: no transaction is spent on a known refusal', async () => {
  const { chain, m, mk } = setup({ pullAmount: '6000' })
  chain.delegations.get(PDA)!.pulled = 5_000n
  assert.deepEqual(await mk().tick(), { [m.id]: 'cap_already_used' })
  assert.equal(chain.sent.length, 0)
})

test('demoOverCap lands a real refusal and produces the refused receipt', async () => {
  const { chain, store, m, mk } = setup()
  const r = await mk().demoOverCap(m)
  assert.equal(r.customCode, 400)
  assert.equal(chain.sent[0]!.amount, 10_001n)
  assert.equal(store.events(OWNER)[0]!.kind, 'refused')
})

test('receipt for a grant made outside nuntius tells the user to check it', () => {
  const msg = receiptMessage(
    {
      kind: 'granted',
      at: 0,
      delegationPda: PDA,
      delegatee: DELEGATEE,
      label: null,
      amountBaseUnits: null,
      decimals: 6,
      symbol: 'USDC',
      signature: null,
      actor: 'other',
    },
    { cluster: 'mainnet' },
  )
  assert.equal(msg.title, 'New permission on your wallet')
  assert.match(msg.body, /Not created in nuntius/)
})
