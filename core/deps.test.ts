// v1.0.1: the app's npm audit advisories (package.json "overrides", shims/). The
// advisories publish no exploit, so each input is the one the advisory describes;
// each test also proves the shim is what the dependent package really loads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const loadAs = (from: string, id: string) => {
  const file = require.resolve(id, { paths: [path.dirname(require.resolve(from))] })
  return { file, mod: require(file) as unknown }
}

/** decode-uri-component 0.2.2's own output for these inputs, recorded 4 Oct 2026. */
const V022: [string, string][] = [
  ['a%20b', 'a b'],
  ['%E2%82%AC', '€'],
  ['a+b', 'a b'],
  ['%', '%'],
  ['%C0', '%C0'],
  ['%C0%80', '%C0%80'],
  ['%E0%A4%A', '%E0%A4%A'],
  ['%E0%A4%A4%E0', 'त%E0'],
  ['%FE%FF', '��'],
  ['%FF%FE', '��'],
  ['x%C2y', 'x�y'],
  ['%E2%82%AC%C0%E2%82%AC', '€%C0€'],
  ['%F0%9F%98%80%FF', '😀%FF'],
  ['abc%2', 'abc%2'],
  ['%%20%', '% %'],
  ['%e2%82%ac%e2%82', '€%e2%82'],
  ['test%C0%AFtest', 'test%C0%AFtest'],
  ['%ED%A0%80', '%ED%A0%80'],
]

test('decode-uri-component (GHSA-vcc3-ghjq-m6fr): query-string loads the linear shim, with 0.2.2 output', () => {
  const { file, mod } = loadAs('query-string', 'decode-uri-component')
  assert.match(file, /shims[/\\]decode-uri-component[/\\]index\.js$/)
  const decode = mod as (s: string) => string
  for (const [input, want] of V022) assert.equal(decode(input), want, input)
  // A run of malformed escapes: 0.2.2 took 3,893 ms on these 1,200 bytes (measured 4 Oct), 4x per doubling.
  const t = Date.now()
  assert.equal(decode('%C0'.repeat(400)), '%C0'.repeat(400))
  assert.ok(Date.now() - t < 200, `${Date.now() - t} ms`)
})

test('braces (GHSA-vfj7-8cjw-p6xm): micromatch loads the shim; deep nesting is refused, not a stack overflow', () => {
  const { file, mod } = loadAs('micromatch', 'braces')
  assert.match(file, /shims[/\\]braces[/\\]index\.js$/)
  const braces = mod as { expand(s: string): string[]; compile(s: string): string }
  // 9,800 characters, under braces' own 10,000 limit: 3.0.3 throws RangeError (stack exhausted).
  const deep = '{'.repeat(4900) + '}'.repeat(4900)
  for (const fn of ['expand', 'compile'] as const)
    assert.throws(
      () => braces[fn](deep),
      (e: unknown) => e instanceof SyntaxError && /max depth/.test(e.message),
    )
  assert.deepEqual(braces.expand('a{1..3}b'), ['a1b', 'a2b', 'a3b'])
  assert.deepEqual(braces.expand('src/{a,b}.ts'), ['src/a.ts', 'src/b.ts'])
})

test('uuid (GHSA-w5hq-g745-h8pq): xcode loads uuid 11.1.1 and still makes its ids', () => {
  const { file } = loadAs('xcode', 'uuid/package.json')
  assert.equal((require(file) as { version: string }).version, '11.1.1')
  const xcode = require('xcode') as { project(p: string): { hash: unknown; generateUuid(): string } }
  const p = xcode.project('/dev/null')
  p.hash = { project: { objects: {} } }
  assert.match(p.generateUuid(), /^[0-9A-F]{24}$/)
})
