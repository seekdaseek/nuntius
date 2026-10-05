// Preflight on every send but one (2 Oct audit, finding 7). Every server send goes out with
// the RPC node's preflight at 'confirmed'; the only send that skips it is the over-cap demo,
// whose refusal must land on chain as the 0x190 proof. This fails if any other send skips it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SEND_OPTIONS, sendOverCapProof, sendWire, type Rpc } from './tx.js'

// The compiled tests run from dist/; the sources are next to it in src/.
const SRC = join(new URL('.', import.meta.url).pathname, '..', 'src')

/** The server's own code: every .ts under src/, without tests and the test harness. */
function serverSources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return relative(SRC, p) === 'test' ? [] : serverSources(p)
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []
  })
}

/** The body of `export async function <name>` in a source text. */
function body(text: string, name: string): string {
  const at = text.indexOf(`export async function ${name}(`)
  assert.ok(at >= 0, `${name} is defined`)
  return text.slice(at, text.indexOf('\n}\n', at) + 2)
}

/** Every place that turns preflight off, outside the one allowed function. */
export function preflightSkips(files: { name: string; text: string }[]): string[] {
  const bad: string[] = []
  for (const { name, text } of files) {
    const allowed = name === 'tx.ts' ? body(text, 'sendOverCapProof') : ''
    for (const m of text.matchAll(/skipPreflight\s*:\s*([^,}\s]+)/g)) {
      if (m[1] === 'false') continue
      const inAllowed =
        allowed && text.indexOf(allowed) <= m.index! && m.index! < text.indexOf(allowed) + allowed.length
      if (!inAllowed) bad.push(`${name}: skipPreflight: ${m[1]}`)
    }
  }
  return bad
}

const sources = serverSources().map((p) => ({ name: relative(SRC, p), text: readFileSync(p, 'utf8') }))

test('the scanner catches a send that skips preflight (positive control)', () => {
  const planted = [
    { name: 'guard.ts', text: 'await rpc.sendTransaction(w, { encoding: "base64", skipPreflight: true }).send()' },
  ]
  assert.deepEqual(preflightSkips(planted), ['guard.ts: skipPreflight: true'])
  assert.deepEqual(preflightSkips([{ name: 'x.ts', text: 'f({ skipPreflight: flag })' }]), [
    'x.ts: skipPreflight: flag',
  ])
  assert.ok(sources.length > 20, `${sources.length} server source files scanned`)
})

test('no server send skips preflight except the over-cap proof', () => {
  assert.deepEqual(preflightSkips(sources), [])
  const tx = sources.find((s) => s.name === 'tx.ts')!.text
  assert.match(body(tx, 'sendOverCapProof'), /skipPreflight: true/, 'the over-cap proof is the one that does')
  // Only tx.ts talks to sendTransaction: sendWire (preflight on) and sendOverCapProof.
  const senders = sources.filter((s) => /\.sendTransaction\(/.test(s.text)).map((s) => s.name)
  assert.deepEqual(senders, ['tx.ts'])
  assert.equal(tx.match(/\.sendTransaction\(/g)!.length, 2)
})

test('the over-cap proof send is reached only from Executor.demoOverCap', () => {
  const uses = sources.filter((s) => s.text.includes('sendOverCapProof')).map((s) => s.name)
  assert.deepEqual(uses.sort(), ['executor.ts', 'tx.ts'])
  const ex = sources.find((s) => s.name === 'executor.ts')!.text
  assert.equal(ex.match(/sendOverCapProof\(/g)!.length, 1, 'only rpcChain.sendProof wraps it')
  assert.match(ex, /sendProof: \(wire\) => sendOverCapProof\(rpc, wire\)/)
  const calls = [...ex.matchAll(/\.sendProof\(/g)].map((m) => m.index!)
  assert.equal(calls.length, 1, 'chain.sendProof is called once')
  const demo = ex.indexOf('async demoOverCap(')
  const next = ex.indexOf('\n  }\n', demo)
  assert.ok(calls[0]! > demo && calls[0]! < next, 'and that call is inside demoOverCap')
})

test('sendWire asks for preflight at confirmed; sendOverCapProof skips it', async () => {
  const seen: unknown[] = []
  const rpc = {
    sendTransaction: (_wire: string, cfg: unknown) => ({
      send: async () => {
        seen.push(cfg)
      },
    }),
  } as unknown as Rpc
  await sendWire(rpc, 'AA==')
  await sendOverCapProof(rpc, 'AA==')
  assert.deepEqual(seen[0], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' })
  assert.deepEqual(seen[0], SEND_OPTIONS)
  assert.deepEqual(seen[1], { encoding: 'base64', skipPreflight: true })
})
