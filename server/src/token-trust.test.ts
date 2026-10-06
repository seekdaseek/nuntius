// The backing page's trust badges: read from the mint and Metaplex metadata accounts as the
// programs lay them out, and nothing claimed when an account is missing or unreadable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { metadataMutability, mintAuthorities, readTokenTrust } from './token-trust.js'
import type { MeteoraConnection } from './meteora.js'

const A = new PublicKey('4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7')
const B = new PublicKey('23fstLLk5nv17NUpbsyWgEkkwHM3uKpxtvXhrLhd3SHP')
const MINT = 'jYCJQbTyVKCCpuGyGP4uqoy1cF8bCtCarnWsU5xQ4B2'
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

/** An SPL mint: COption mint authority, supply, decimals, initialized, COption freeze authority. */
function mintAccount(mintAuthority: PublicKey | null, freezeAuthority: PublicKey | null): Buffer {
  const b = Buffer.alloc(82)
  if (mintAuthority) {
    b.writeUInt32LE(1, 0)
    mintAuthority.toBuffer().copy(b, 4)
  }
  b[44] = 6
  b[45] = 1
  if (freezeAuthority) {
    b.writeUInt32LE(1, 46)
    freezeAuthority.toBuffer().copy(b, 50)
  }
  return b
}

/** Metaplex metadata as the program writes it: fixed-width, zero-padded strings. */
function metadataAccount(updateAuthority: PublicKey, isMutable: boolean, creators = 0): Buffer {
  const str = (s: string, width: number) => {
    const b = Buffer.alloc(4 + width)
    b.writeUInt32LE(width, 0)
    Buffer.from(s).copy(b, 4)
    return b
  }
  const creatorPart =
    creators === 0
      ? Buffer.from([0])
      : Buffer.concat([Buffer.from([1]), Buffer.from(new Uint32Array([creators]).buffer), Buffer.alloc(34 * creators)])
  return Buffer.concat([
    Buffer.from([4]),
    updateAuthority.toBuffer(),
    new PublicKey(MINT).toBuffer(),
    str('nimus', 32),
    str('NIMUS', 10),
    str('https://nuntius.ochinimus.app/m/x.json', 200),
    Buffer.from([0, 0]),
    creatorPart,
    Buffer.from([0, isMutable ? 1 : 0]),
    Buffer.alloc(40),
  ])
}

test('mint authorities: none, both, and a broken option tag', () => {
  assert.deepEqual(mintAuthorities(mintAccount(null, null)), { mintAuthority: null, freezeAuthority: null })
  assert.deepEqual(mintAuthorities(mintAccount(A, B)), { mintAuthority: A.toBase58(), freezeAuthority: B.toBase58() })
  const broken = mintAccount(null, null)
  broken.writeUInt32LE(7, 0)
  assert.equal(mintAuthorities(broken), null)
  assert.equal(mintAuthorities(Buffer.alloc(40)), null)
})

test('metadata: update authority, is_mutable, past a creators list; another account kind is not read', () => {
  const none = new PublicKey('11111111111111111111111111111111')
  assert.deepEqual(metadataMutability(metadataAccount(none, false)), {
    updateAuthority: none.toBase58(),
    isMutable: false,
  })
  assert.deepEqual(metadataMutability(metadataAccount(A, true, 2)), { updateAuthority: A.toBase58(), isMutable: true })
  const other = metadataAccount(A, true)
  other[0] = 6 // MasterEditionV2, not metadata
  assert.equal(metadataMutability(other), null)
})

function conn(accounts: ({ owner: PublicKey; data: Buffer } | null)[] | Error): MeteoraConnection {
  return {
    getMultipleAccountsInfo: async () => {
      if (accounts instanceof Error) throw accounts
      return accounts
    },
  } as unknown as MeteoraConnection
}

test('the three promises: all hold, none hold, and a failed read claims nothing', async () => {
  const none = new PublicKey('11111111111111111111111111111111')
  const locked = await readTokenTrust(
    conn([
      { owner: TOKEN, data: mintAccount(null, null) },
      { owner: METAPLEX, data: metadataAccount(none, false) },
    ]),
    MINT,
  )
  assert.deepEqual(
    [locked.mintAuthorityDisabled, locked.freezeAuthorityDisabled, locked.metadataPermanent],
    [true, true, true],
  )
  assert.ok(locked.metadata)

  const open = await readTokenTrust(
    conn([
      { owner: TOKEN, data: mintAccount(A, B) },
      { owner: METAPLEX, data: metadataAccount(A, true) },
    ]),
    MINT,
  )
  assert.deepEqual(
    [open.mintAuthorityDisabled, open.freezeAuthorityDisabled, open.metadataPermanent],
    [false, false, false],
  )

  // An authority set but the metadata frozen by is_mutable: still permanent.
  const frozen = await readTokenTrust(
    conn([
      { owner: TOKEN, data: mintAccount(null, null) },
      { owner: METAPLEX, data: metadataAccount(A, false) },
    ]),
    MINT,
  )
  assert.equal(frozen.metadataPermanent, true)

  for (const c of [
    conn(new Error('rpc down')),
    conn([null, null]),
    // Accounts at those addresses owned by something else are not read as a mint or metadata.
    conn([
      { owner: METAPLEX, data: mintAccount(null, null) },
      { owner: TOKEN, data: metadataAccount(none, false) },
    ]),
  ]) {
    const t = await readTokenTrust(c, MINT)
    assert.deepEqual([t.mintAuthorityDisabled, t.freezeAuthorityDisabled, t.metadataPermanent], [null, null, null])
  }
})
