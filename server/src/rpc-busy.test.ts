// A busy RPC is tried again briefly, then named as busy; anything else is thrown at once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { busyRetry, ChainBusy, transientRpcError } from './rpc-busy.js'

const rateLimit = () => new Error('429 Too Many Requests: Too Many Requests')

test('busyRetry: a read that 429s twice is tried a third time and answers', async () => {
  let n = 0
  const v = await busyRetry(async () => {
    n += 1
    if (n <= 2) throw rateLimit()
    return 'ok'
  }, [1, 1])
  assert.equal(v, 'ok')
  assert.equal(n, 3)
})

test('busyRetry: a read that stays busy is ChainBusy after three tries, and that is transient', async () => {
  let n = 0
  await assert.rejects(
    busyRetry(async () => {
      n += 1
      throw rateLimit()
    }, [1, 1]),
    (e: unknown) => e instanceof ChainBusy && /busy \(429 Too Many Requests/.test((e as Error).message),
  )
  assert.equal(n, 3)
  assert.equal(transientRpcError(new ChainBusy(rateLimit())), true)
})

test('busyRetry: an answer that is not a busy RPC is thrown at once, untouched', async () => {
  let n = 0
  const wrong = new Error('no DBC pool at X')
  await assert.rejects(
    busyRetry(async () => {
      n += 1
      throw wrong
    }, [1, 1]),
    (e: unknown) => e === wrong,
  )
  assert.equal(n, 1)
})
