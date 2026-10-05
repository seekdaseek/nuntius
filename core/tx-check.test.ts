// The transaction check on real transactions from the server's own builders
// (core/fixtures/server-tx.json, written by server/src/tx-check.localnet.test.ts
// against the real program): each one passes as built and fails after one change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getAddressDecoder } from '@solana/kit'
import { checkTransaction, MISMATCH, PROGRAMS, TxMismatch, type Expect } from './tx-check.ts'
import { getU64, setU64, tamper, type Editable } from './tx-tamper.ts'

const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'server-tx.json'), 'utf8')) as Record<
  string,
  { base64: string; expect: Record<string, unknown> }
>
const fx = (name: string) => {
  const f = raw[name]!
  const expect = Object.fromEntries(
    Object.entries(f.expect).map(([k, v]) => [
      k,
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ]),
  ) as unknown as Expect
  return { base64: f.base64, expect }
}
const fresh = () => getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)))

async function refused(base64: string, e: Expect, why: string) {
  await assert.rejects(
    checkTransaction(base64, e),
    (err: unknown) => {
      assert.ok(err instanceof TxMismatch, why)
      assert.equal(err.message, MISMATCH, 'one plain sentence for the user')
      return true
    },
    why,
  )
}

/** A System transfer of 1 SOL from the wallet to a fresh address, appended. */
const extraTransfer = (m: Editable) => {
  const data = new Uint8Array(12)
  data[0] = 2
  setU64(data, 4, 1_000_000_000n)
  m.ixs.push({ programAddressIndex: m.add(PROGRAMS.system), accountIndices: [0, m.add(fresh())], data })
}
const unknownProgram = (m: Editable) =>
  m.ixs.push({ programAddressIndex: m.add(fresh()), accountIndices: [0], data: new Uint8Array([1]) })

test('every server-built transaction passes as built', async () => {
  assert.deepEqual(Object.keys(raw).sort(), [
    'grant-back',
    'grant-first',
    'grant-second',
    'launch',
    'revoke-last',
    'revoke-trim',
  ])
  for (const name of Object.keys(raw)) {
    const { base64, expect } = fx(name)
    await checkTransaction(base64, expect)
  }
})

test('a grant is refused after any change to what the screen showed', async () => {
  const { base64, expect } = fx('grant-first')
  const g = expect as Extract<Expect, { kind: 'grant' }>
  const subs = PROGRAMS.subscriptions
  const cases: [string, string, Expect][] = [
    [
      'amount per period',
      tamper(base64, (m) => setU64(m.find(subs, 2).data, 9, getU64(m.find(subs, 2).data, 9) + 1n)),
      g,
    ],
    ['period', tamper(base64, (m) => setU64(m.find(subs, 2).data, 17, 3_600n)), g],
    [
      'expiry a year later',
      tamper(base64, (m) => setU64(m.find(subs, 2).data, 33, getU64(m.find(subs, 2).data, 33) + 31_536_000n)),
      g,
    ],
    ['payee (the delegatee)', tamper(base64, (m) => (m.find(subs, 2).accountIndices[3] = m.add(fresh()))), g],
    ['approval delegate', tamper(base64, (m) => (m.find(PROGRAMS.token, 13).accountIndices[2] = m.add(fresh()))), g],
    ['approval mint', tamper(base64, (m) => (m.find(PROGRAMS.token, 13).accountIndices[1] = m.add(fresh()))), g],
    ['approval amount', tamper(base64, (m) => setU64(m.find(PROGRAMS.token, 13).data, 1, 2n ** 64n - 1n)), g],
    ['an extra transfer', tamper(base64, extraTransfer), g],
    ['another fee payer', tamper(base64, (m) => m.setFeePayer(fresh())), g],
    ['an unknown program', tamper(base64, unknownProgram), g],
    ['the approval removed', tamper(base64, (m) => m.ixs.pop()), g],
    // The same bytes against what the user typed and saw: another token, amount or total.
    ['another mint than typed', base64, { ...g, mint: fresh() }],
    ['another amount than typed', base64, { ...g, amountPerPeriod: g.amountPerPeriod + 1n }],
    ['another total than shown', base64, { ...g, shownAllowance: 1n }],
    ['"no limit" shown, an approval sent', base64, { ...g, shownAllowance: null }],
    ['another executor than this build trusts', base64, { ...g, delegatee: fresh() }],
    ['another wallet signed in', base64, { ...g, wallet: fresh() }],
  ]
  for (const [why, tx, e] of cases) await refused(tx, e, why)
})

test('a back permission is refused if its token account is not the backer’s own', async () => {
  const { base64, expect } = fx('grant-back')
  await refused(
    tamper(base64, (m) => (m.find(PROGRAMS.ata, 1).accountIndices[2] = m.add(fresh()))),
    expect,
    'owner',
  )
  await refused(base64, { ...expect, baseMint: fresh() } as Expect, 'another launch token')
})

test('a revoke is refused unless it ends only that permission (and trims, never raises, the approval)', async () => {
  const trim = fx('revoke-trim')
  const last = fx('revoke-last')
  const t = trim.expect as Extract<Expect, { kind: 'revoke' }>
  await refused(trim.base64, { ...t, delegationPda: fresh() }, 'another permission')
  await refused(trim.base64, { ...t, allowance: 1n }, 'the trim raises the allowance')
  await refused(
    tamper(trim.base64, (m) => (m.find(PROGRAMS.token, 13).accountIndices[2] = m.add(fresh()))),
    t,
    'trim delegate',
  )
  await refused(tamper(trim.base64, extraTransfer), t, 'an extra transfer')
  await refused(
    tamper(trim.base64, (m) => m.setFeePayer(fresh())),
    t,
    'another fee payer',
  )
  await refused(
    tamper(last.base64, (m) => m.find(PROGRAMS.subscriptions, 14).accountIndices.push(m.add(fresh()))),
    last.expect,
    'rent to another receiver',
  )
  await refused(tamper(last.base64, unknownProgram), last.expect, 'an unknown program')
})

test('a launch is refused with anything but its own pool instructions', async () => {
  const { base64, expect } = fx('launch')
  await refused(tamper(base64, extraTransfer), expect, 'an extra transfer')
  await refused(
    tamper(base64, (m) => (m.find(PROGRAMS.dbc, 0x8c).data[1] = 0)),
    expect,
    'another DBC instruction',
  )
  await refused(base64, { ...expect, quoteMint: fresh() } as Expect, 'another quote token')
  await refused(base64, { ...expect, config: fresh() } as Expect, 'a pool on another config')
  await refused(
    tamper(base64, (m) => m.setFeePayer(fresh())),
    expect,
    'another fee payer',
  )
})

test('what a grant must say comes from the screen and this build, never from the server', async () => {
  const { expectGrant, baseUnits } = await import('./tx-check.ts')
  assert.equal(baseUnits('0.05', 6), 50_000n)
  assert.equal(baseUnits('25', 6), 25_000_000n)
  assert.equal(baseUnits('0.0000001', 6), null, 'more decimals than the token has')
  const base = {
    wallet: fresh(),
    symbol: 'USDC',
    amount: '0.05',
    period: 'day',
    untilDays: 30,
    executor: fresh(),
    shownAllowance: '1.5',
    nowMs: 1_800_000_000_000,
  }
  const e = expectGrant(base)
  assert.equal(e.mint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'the pinned USDC mint')
  assert.equal(e.amountPerPeriod, 50_000n)
  assert.equal(e.periodLengthS, 86_400)
  assert.equal(e.shownAllowance, 1_500_000n)
  assert.equal(expectGrant({ ...base, shownAllowance: null }).shownAllowance, null)
  assert.throws(
    () => expectGrant({ ...base, executor: null }),
    TxMismatch,
    'a build without the executor refuses grants',
  )
  assert.throws(() => expectGrant({ ...base, symbol: 'BONK' }), TxMismatch, 'only the pinned tokens')
})
