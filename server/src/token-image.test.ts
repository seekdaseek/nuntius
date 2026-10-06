// The backing page's token image: read from the token's metadata, locally for this server's
// own URIs, and from anywhere else only within the guards (public https host, no redirect,
// 64 KB, https image).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { isPublicAddress, TokenImages, uriFromMetadata, type TokenImageDeps } from './token-image.js'

const ORIGIN = 'https://nuntius.ochinimus.app'
const MINT = 'GJKKCX3vYaYrfYVBbi1Thu3ofo31ussxLjiJPFZ76j5L'
const TOKENS = path.join(import.meta.dirname, '..', 'static', 'tokens')

/** A Metaplex metadata account as the program writes it: fixed-width, zero-padded strings. */
function metadataAccount(name: string, symbol: string, uri: string): Buffer {
  const str = (s: string, width: number) => {
    const b = Buffer.alloc(4 + width)
    b.writeUInt32LE(width, 0)
    Buffer.from(s).copy(b, 4)
    return b
  }
  return Buffer.concat([Buffer.alloc(65, 4), str(name, 32), str(symbol, 10), str(uri, 200), Buffer.alloc(100)])
}

function images(over: Partial<TokenImageDeps> & { uri?: string | null }) {
  let reads = 0
  const fetched: string[] = []
  const t = new TokenImages({
    origin: ORIGIN,
    launchImage: (mint) => (mint === MINT ? `${ORIGIN}/t/nimus.png` : null),
    tokensDir: TOKENS,
    readUri: async () => {
      reads++
      return over.uri === undefined ? null : over.uri
    },
    lookup: async () => [{ address: '93.184.215.14', family: 4 }],
    fetch: (async (url: URL) => {
      fetched.push(String(url))
      return new Response(JSON.stringify({ image: 'https://arweave.net/abc.png' }), { status: 200 })
    }) as typeof fetch,
    ...over,
  })
  return { t, reads: () => reads, fetched }
}

test('the URI is read from a Metaplex metadata account, padding and all', () => {
  const uri = `${ORIGIN}/m/${MINT}.json`
  assert.equal(uriFromMetadata(metadataAccount('nimus', 'NIMUS', uri)), uri)
  assert.equal(uriFromMetadata(Buffer.alloc(40)), null)
})

test('a nuntius launch: its stored image, served from this origin, comes back as a path', async () => {
  const { t, fetched } = images({ uri: `${ORIGIN}/m/${MINT}.json` })
  assert.equal(await t.imageOf(MINT), '/t/nimus.png')
  assert.deepEqual(fetched, [], 'nothing fetched for our own metadata')
})

test('a token whose metadata is a file in static/tokens: read from disk', async () => {
  const { t, fetched } = images({ uri: `${ORIGIN}/t/proof.json` })
  assert.equal(await t.imageOf(MINT), '/identity-icon-192.png')
  assert.deepEqual(fetched, [])
})

test('an outside token: fetched from a public https host, its https image passed on, then cached', async () => {
  const { t, fetched, reads } = images({ uri: 'https://ipfs.io/ipfs/bafy/meta.json' })
  assert.equal(await t.imageOf(MINT), 'https://arweave.net/abc.png')
  assert.equal(await t.imageOf(MINT), 'https://arweave.net/abc.png')
  assert.deepEqual(fetched, ['https://ipfs.io/ipfs/bafy/meta.json'])
  assert.equal(reads(), 1)
})

test('refused before any request: http, another port, credentials, localhost, a private address', async () => {
  for (const uri of [
    'http://example.com/meta.json',
    'https://example.com:8443/meta.json',
    'https://user:pw@example.com/meta.json',
    'https://localhost/meta.json',
    'https://127.0.0.1/meta.json',
    'https://[::1]/meta.json',
    'ipfs://bafy/meta.json',
  ]) {
    const lookup = async (host: string) =>
      host === '127.0.0.1'
        ? [{ address: '127.0.0.1', family: 4 as const }]
        : host === '::1'
          ? [{ address: '::1', family: 6 as const }]
          : [{ address: '93.184.215.14', family: 4 as const }]
    const { t, fetched } = images({ uri, lookup })
    assert.equal(await t.imageOf(MINT), null, uri)
    assert.deepEqual(fetched, [], uri)
  }
  // A public name with one private address among its answers.
  const { t, fetched } = images({
    uri: 'https://rebind.example/meta.json',
    lookup: async () => [
      { address: '93.184.215.14', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ],
  })
  assert.equal(await t.imageOf(MINT), null)
  assert.deepEqual(fetched, [])
})

test('refused after the request: a redirect, a body over 64 KB, an image that is not https', async () => {
  const answer = (r: Response) => ({ uri: 'https://example.com/meta.json', fetch: (async () => r) as typeof fetch })
  const redirect = new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/meta.json' } })
  assert.equal(await images(answer(redirect)).t.imageOf(MINT), null)
  const big = new Response(JSON.stringify({ image: 'https://a.b/c.png', pad: 'x'.repeat(70_000) }), { status: 200 })
  assert.equal(await images(answer(big)).t.imageOf(MINT), null)
  for (const image of ['http://a.b/c.png', 'javascript:alert(1)', 'https://a.b/"onerror=x', 42]) {
    const r = new Response(JSON.stringify({ image }), { status: 200 })
    assert.equal(await images(answer(r)).t.imageOf(MINT), null, String(image))
  }
})

test('private, loopback, link-local, shared and mapped addresses are not public', () => {
  for (const a of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0'])
    assert.equal(isPublicAddress(a, 4), false, a)
  for (const a of ['::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(a, 6), false, a)
  assert.equal(isPublicAddress('93.184.215.14', 4), true)
  assert.equal(isPublicAddress('2606:4700::1111', 6), true)
})
