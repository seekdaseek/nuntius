import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { CLIENT_HEADER, CLIENT_VERSION, clientHeaders } from './client-version.ts'

const read = (f: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, '..', f), 'utf8'))

test('the version header is the version app.json builds, and package.json agrees', () => {
  assert.equal(CLIENT_VERSION, read('app.json').expo.version)
  assert.equal(CLIENT_VERSION, read('package.json').version)
  assert.deepEqual(clientHeaders, { 'x-nuntius-client': CLIENT_VERSION })
  // The server reads the same header name (server/src/client-version.ts).
  assert.match(
    readFileSync(path.join(import.meta.dirname, '..', 'server', 'src', 'client-version.ts'), 'utf8'),
    new RegExp(`CLIENT_HEADER = '${CLIENT_HEADER}'`),
  )
})

test('every API client sends the header', () => {
  for (const f of [
    'features/mandates/mandates-api.ts',
    'features/account/nuntius-api.ts',
    'features/push/push-api.ts',
    'features/widget/refresh-widget.tsx',
  ]) {
    const src = readFileSync(path.join(import.meta.dirname, '..', f), 'utf8')
    const fetches = src.match(/\bfetch\(/g)?.length ?? 0
    const sent = src.match(/\.\.\.clientHeaders\b/g)?.length ?? 0
    assert.ok(fetches > 0, `${f} calls fetch`)
    assert.equal(sent, fetches, `${f}: ${fetches} fetch calls, ${sent} carry the header`)
  }
})
