// v1.0.1 moves the session token and the wallet auth_token into the keystore
// without signing anyone out (core/secure-migrate.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readMigrating, writeSecure, type Kv } from './secure-migrate.ts'

function mem(init: Record<string, string> = {}, failSet = false): Kv & { data: Record<string, string> } {
  const data = { ...init }
  return {
    data,
    get: async (k) => data[k] ?? null,
    set: async (k, v) => {
      if (failSet) throw new Error('keystore unavailable')
      data[k] = v
    },
    remove: async (k) => {
      delete data[k]
    },
  }
}

test('first start after the update: the old value moves to the keystore, the old key is deleted', async () => {
  const secure = mem()
  const legacy = mem({ 'nuntius-auth-v1': '{"session":"s"}' })
  assert.equal(await readMigrating('nuntius-auth-v1', secure, legacy), '{"session":"s"}', 'still signed in')
  assert.deepEqual(secure.data, { 'nuntius-auth-v1': '{"session":"s"}' })
  assert.deepEqual(legacy.data, {}, 'nothing left in AsyncStorage')
  assert.equal(
    await readMigrating('nuntius-auth-v1', secure, legacy),
    '{"session":"s"}',
    'next start reads the keystore',
  )
})

test('a failed keystore write keeps the old value and the user signed in; the next start retries', async () => {
  const legacy = mem({ k: 'v' })
  assert.equal(await readMigrating('k', mem({}, true), legacy), 'v')
  assert.deepEqual(legacy.data, { k: 'v' }, 'not deleted before it is stored securely')
  const secure = mem()
  assert.equal(await readMigrating('k', secure, legacy), 'v')
  assert.deepEqual([secure.data, legacy.data], [{ k: 'v' }, {}])
})

test('nothing stored: signed out; writes and sign-out touch the keystore and clear any old copy', async () => {
  assert.equal(await readMigrating('k', mem(), mem()), null)
  const secure = mem()
  const legacy = mem({ k: 'old' })
  await writeSecure('k', 'new', secure, legacy)
  assert.deepEqual([secure.data, legacy.data], [{ k: 'new' }, {}])
  await writeSecure('k', null, secure, legacy)
  assert.deepEqual(secure.data, {}, 'sign-out deletes it')
})
