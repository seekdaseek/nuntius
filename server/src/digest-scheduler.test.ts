// The digest reads the wallet's live permissions once per digest it sends or tries. A failed try
// waits 10 minutes: 23-24 Oct, a digest failing on the busy RPC was retried (and its permissions
// read) every minute, 172 times.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb, Store } from './db.js'
import { MandateStore } from './mandate-store.js'
import { createLogger } from './log.js'
import { DIGEST_RETRY_MS, runDigests } from './digest-scheduler.js'

const WALLET = '4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7'

test('the live permissions are read once per digest try; a failed try waits 10 minutes', async () => {
  const db = openDb(':memory:')
  const store = new Store(db)
  const mandates = new MandateStore(db)
  const session = 'S'.repeat(43)
  // 21:00 UTC (00:00 at +180 minutes), saved a day before.
  const day = Date.UTC(2026, 9, 24)
  store.createSession(session, WALLET, day - 86_400_000)
  store.claimSgtMint(session, 'Sgt1111111111111111111111111111111111111111')
  mandates.setDigestPrefs(WALLET, 0, 180, true, day - 86_400_000)
  let reads = 0
  let busy = true
  const pushes: string[] = []
  const lines: string[] = []
  const deps = {
    store,
    mandates,
    push: { toAddress: async (_a: string, m: { title: string }) => (pushes.push(m.title), [200]) },
    log: createLogger((l) => lines.push(l)),
    live: async () => {
      reads++
      if (busy) throw new Error('HTTP error (429): Too Many Requests')
      return []
    },
    retryAt: new Map<string, number>(),
  }
  const due = day + 21 * 3_600_000
  // The scheduler looks every minute.
  for (let t = due; t < due + DIGEST_RETRY_MS; t += 60_000) await runDigests(deps, t)
  assert.equal(reads, 1, 'one read in the first ten minutes, not ten')
  assert.equal(lines.filter((l) => l.includes('digest_failed')).length, 1)
  busy = false
  assert.deepEqual(await runDigests(deps, due + DIGEST_RETRY_MS), [WALLET], 'tried again after 10 minutes, and sent')
  assert.equal(reads, 2)
  assert.equal(pushes.length, 1)
  for (let t = due + DIGEST_RETRY_MS + 60_000; t < due + 3_600_000; t += 60_000) await runDigests(deps, t)
  assert.equal(reads, 2, 'sent today: nothing more is read')
})
