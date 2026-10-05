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
  // The one send without our simulation, on purpose: the refusal must land to be proof.
  assert.deepEqual(chain.simulations, [])
  // And without the RPC node's preflight: it goes out through sendProof, never send.
  assert.equal(chain.proofSends.length, 1)
  assert.deepEqual(chain.sends, [])
})

test('every send is simulated first; a transaction the program would refuse is never sent', async () => {
  const { chain, store, pushes, clock, m, mk } = setup()
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  assert.deepEqual(chain.simulations, chain.sends, 'the same signed bytes, simulated before they went out')
  clock.advance(61)
  chain.simRefusals.push({ err: '{"InstructionError":[2,{"Custom":400}]}', customCode: 400 })
  assert.deepEqual(await ex.tick(), { [m.id]: 'refused' })
  assert.equal(chain.sends.length, 1, 'the refused pull was never sent, so no fee was paid')
  assert.deepEqual(chain.proofSends, [], 'a scheduled pull never takes the preflight-off path')
  assert.equal(chain.sent.length, 1)
  const row =
    store.pullsFor(PDA).find((r) => r.periodStart > store.pullsFor(PDA)[0]!.periodStart) ?? store.pullsFor(PDA)[1]!
  assert.equal(row.state, 'refused')
  assert.equal(row.errorCode, 400)
  assert.equal(pushes.length, 1, 'nothing reached the chain, so there is no refusal to prove')
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' }, 'not retried in the period')
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

test('a dropped pull is rebroadcast with the same bytes and lands in seconds, not after the blockhash expires', async () => {
  const { chain, mk, clock, pushes } = setup()
  chain.sendDrops = 1 // the first send is accepted by the RPC and never lands (30 Sep, mainnet)
  let slept = 0
  const ex = mk({
    settleMs: 20_000,
    rebroadcastMs: 2_000,
    sleep: async (ms: number) => {
      slept += ms
      if (slept % 1000 === 0) clock.advance(1) // the clocks move in whole seconds
    },
  })
  const out = await ex.tick()
  assert.deepEqual(Object.values(out), ['landed'])
  assert.equal(new Set(chain.sends).size, 1, 'one signature: the rebroadcast is the same signed transaction')
  assert.ok(chain.sends.length >= 2, 'it was sent again')
  assert.deepEqual(chain.proofSends, [], 'rebroadcasts keep preflight on')
  assert.equal(chain.sent.length, 1, 'and landed exactly once')
  assert.ok(slept <= 3_000, `landed within about 2 s of the drop (waited ${slept} ms)`)
  assert.equal(pushes.filter((p) => /received/.test(p.title)).length, 1)
})

test('kick: a confirmed permission is pulled at once, without waiting for the interval', async () => {
  const { chain, mk } = setup()
  mk().kick()
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(chain.sent.length, 1)
})

test('kick: a kick that arrives during a tick runs one more tick after it', async () => {
  const { chain, mk, clock } = setup()
  chain.sendDrops = 1 // keeps the first tick busy settling
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const ex = mk({
    settleMs: 5_000,
    rebroadcastMs: 2_000,
    sleep: async () => {
      await gate
      clock.advance(1)
    },
  })
  let ticks = 0
  const tick = ex.tick.bind(ex)
  ex.tick = () => (ticks++, tick())
  const first = ex.tick()
  ex.kick() // the tick is running: this must not be lost
  assert.equal(ticks, 1, 'no second tick while the first runs')
  release()
  await first
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(ticks, 2, 'the queued kick ran one more tick')
})

test('the period is the program’s: a wall clock ahead of the chain claims nothing early, and no period is lost', async () => {
  const { chain, store, pushes, clock, m, mk } = setup()
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  // The server's clock passes the period boundary 2 s before the program's does (mainnet's
  // confirmed block time ran 1 to 2 s behind the wall clock, 6 Oct).
  clock.advance(61)
  chain.nowS -= 3n
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' }, 'the program has not opened the next period yet')
  assert.equal(store.pullsFor(PDA).length, 1, 'nothing claimed early')
  assert.equal(pushes.filter((p) => p.title.startsWith('Refused')).length, 0, 'no false refusal')
  chain.nowS += 3n
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' }, 'once the program opens it, the pull goes')
  assert.equal(store.pullsFor(PDA).length, 2)
  assert.equal(chain.delegations.get(PDA)!.pulled, 10_000n)
})

test('the same lag, judged by the wall clock, would lose the period (the old behaviour, kept as a control)', async () => {
  const { chain, store, clock, m, mk } = setup()
  const ex = mk()
  // A chain port without a clock: the executor falls back to the wall clock.
  ;(chain as { clock?: unknown }).clock = undefined
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  clock.advance(61)
  chain.nowS -= 3n
  assert.deepEqual(await ex.tick(), { [m.id]: 'refused' }, 'claimed early: the program refuses with 0x190')
  chain.nowS += 3n
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' }, 'and the period is lost')
  assert.equal(store.pullsFor(PDA).at(-1)!.state, 'refused')
})

test('an unreadable clock: the wall clock less the margin, so a boundary is never claimed early', async () => {
  const { chain, store, lines, clock, m, mk } = setup()
  const ex = mk()
  assert.deepEqual(await ex.tick(), { [m.id]: 'landed' })
  chain.clock = async () => {
    throw new Error('rpc down')
  }
  clock.advance(61)
  chain.nowS -= 3n
  assert.deepEqual(await ex.tick(), { [m.id]: 'period_done' })
  assert.equal(store.pullsFor(PDA).length, 1)
  assert.ok(lines.some((l) => l.includes('executor_clock_unread')))
})
