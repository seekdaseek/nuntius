// v1.0.1: the server's npm audit advisories, each fixed by an override or a shim
// (package.json "overrides", ../shims). The advisories publish no exploit, so each
// input is the one the advisory describes; the test also proves the override is
// what the dependent package actually loads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
/** Resolves `id` as the package `from` would, then loads it. */
const loadAs = (from: string, id: string) => {
  const file = require.resolve(id, { paths: [path.dirname(require.resolve(from))] })
  return { file, mod: require(file) as Record<string, unknown> }
}

test('bigint-buffer (GHSA-3gc7-fjrx-p6mg): the shim, with no native code, is what spl-token loads', () => {
  const { file, mod } = loadAs('@solana/buffer-layout-utils', 'bigint-buffer')
  assert.match(file, /shims[/\\]bigint-buffer[/\\]index\.js$/)
  const bb = mod as unknown as {
    toBigIntLE(b: Buffer): bigint
    toBigIntBE(b: Buffer): bigint
    toBufferLE(n: bigint, w: number): Buffer
    toBufferBE(n: bigint, w: number): Buffer
  }
  // The advisory: toBigIntLE() copies its input without checking its size. Empty, short
  // and offset inputs read exactly their own bytes and nothing else.
  assert.equal(bb.toBigIntLE(Buffer.alloc(0)), 0n)
  assert.equal(bb.toBigIntBE(Buffer.alloc(0)), 0n)
  const backing = Buffer.from([0xff, 0x2a, 0xff])
  assert.equal(bb.toBigIntLE(backing.subarray(1, 2)), 42n, 'one byte inside a larger buffer')
  assert.equal(bb.toBigIntLE(Buffer.from('15cd5b0700000000', 'hex')), 123_456_789n)
  assert.equal(bb.toBigIntBE(Buffer.from('00000000075bcd15', 'hex')), 123_456_789n)
  assert.equal(bb.toBufferLE(123_456_789n, 8).toString('hex'), '15cd5b0700000000')
  assert.equal(bb.toBufferBE(123_456_789n, 8).toString('hex'), '00000000075bcd15')
  assert.throws(() => bb.toBigIntLE('not a buffer' as never), TypeError)
  assert.throws(() => bb.toBufferLE(1n, -1), RangeError)
})

test('toml (GHSA-82x6-q7mm-w9cf, GHSA-v5mp-jgw5-2x6j): Anchor loads 4.3.0, which bounds nesting and keeps __proto__ inert', () => {
  const { mod } = loadAs('@coral-xyz/anchor', 'toml')
  const toml = mod as unknown as { parse(s: string | Buffer): Record<string, unknown> }
  const deep = `x = ${'['.repeat(20_000)}${']'.repeat(20_000)}`
  // 3.0.0 throws RangeError (stack exhausted) here; 4.3.0 stops at depth 500.
  assert.throws(
    () => toml.parse(deep),
    (e: unknown) => e instanceof Error && !(e instanceof RangeError),
  )
  toml.parse('[__proto__]\npolluted = "yes"\na.__proto__.polluted2 = "yes"\n')
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(({} as Record<string, unknown>).polluted2, undefined)
  // Anchor's only call: parse(fs.readFileSync("Anchor.toml")), a Buffer, then .provider.cluster.
  // 4.x returns null-prototype objects (part of the pollution fix); property reads are unchanged.
  const parsed = toml.parse(Buffer.from('[provider]\ncluster = "localnet"\n')) as { provider: { cluster: string } }
  assert.equal(parsed.provider.cluster, 'localnet')
})

test('stream-json (GHSA-528h-pc64-c93x) and uuid (GHSA-w5hq-g745-h8pq): gone with jayson 5', () => {
  const { file } = loadAs('@solana/web3.js', 'jayson/package.json')
  assert.equal((require(file) as { version: string }).version, '5.0.0')
  const deps = (require(file) as { dependencies: Record<string, string> }).dependencies
  assert.equal(deps['stream-json'], undefined)
  assert.equal(deps.uuid, undefined)
  assert.throws(() => loadAs('jayson', 'stream-json'), /Cannot find module/)
})
