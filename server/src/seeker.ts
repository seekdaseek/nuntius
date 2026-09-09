/**
 * Seeker Genesis Token (SGT) ownership check, per the documented Solana Mobile
 * verification path: page the wallet's Token-2022 accounts through Helius
 * getTokenAccountsByOwnerV2, then confirm a candidate mint carries the SGT
 * mint authority, metadata pointer and group membership.
 *
 * https://docs.solanamobile.com/marketing/engaging-seeker-users
 */

const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const SGT_MINT_AUTHORITY = 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4'
const SGT_METADATA_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te'
const SGT_GROUP_ADDRESS = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te'

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'nuntius', method, params }),
  })
  if (!response.ok) throw new Error(`rpc http ${response.status}`)
  const data = (await response.json()) as { result?: unknown; error?: { message?: string } }
  if (data.error) throw new Error('rpc error')
  return data.result
}

function get(value: unknown, ...path: string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function extensionState(info: unknown, name: string): unknown {
  const extensions = get(info, 'extensions')
  if (!Array.isArray(extensions)) return undefined
  const match = extensions.find((e) => get(e, 'extension') === name)
  return get(match, 'state')
}

function isSgtMint(account: unknown): boolean {
  const parsed = get(account, 'data', 'parsed')
  if (get(parsed, 'type') !== 'mint') return false
  const info = get(parsed, 'info')
  if (get(info, 'mintAuthority') !== SGT_MINT_AUTHORITY) return false

  const metadata = extensionState(info, 'metadataPointer')
  if (get(metadata, 'authority') !== SGT_MINT_AUTHORITY) return false
  if (get(metadata, 'metadataAddress') !== SGT_METADATA_ADDRESS) return false

  const member = extensionState(info, 'tokenGroupMember')
  if (get(member, 'group') !== SGT_GROUP_ADDRESS) return false

  return true
}

/** Returns the SGT mint address the wallet holds, or null. Throws on RPC failure — fail closed, never fail open. */
export async function checkWalletForSgt(rpcUrl: string, owner: string): Promise<string | null> {
  const candidateMints: string[] = []
  let paginationKey: string | null = null

  do {
    const result = await rpc(rpcUrl, 'getTokenAccountsByOwnerV2', [
      owner,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: 'jsonParsed', limit: 1000, ...(paginationKey ? { paginationKey } : {}) },
    ])
    const accounts = get(result, 'value', 'accounts')
    for (const entry of Array.isArray(accounts) ? accounts : []) {
      const info = get(entry, 'account', 'data', 'parsed', 'info')
      const mint = get(info, 'mint')
      // Transferring an SGT out leaves the old token account open with a balance of 0 — skip those.
      if (typeof mint === 'string' && get(info, 'tokenAmount', 'amount') !== '0') {
        candidateMints.push(mint)
      }
    }
    const nextKey = get(result, 'paginationKey')
    paginationKey = typeof nextKey === 'string' ? nextKey : null
  } while (paginationKey)

  for (let i = 0; i < candidateMints.length; i += 100) {
    const batch = candidateMints.slice(i, i + 100)
    const result = await rpc(rpcUrl, 'getMultipleAccounts', [batch, { encoding: 'jsonParsed' }])
    const accounts = get(result, 'value')
    if (!Array.isArray(accounts)) continue
    for (let j = 0; j < accounts.length; j++) {
      if (isSgtMint(accounts[j])) return batch[j] ?? null
    }
  }

  return null
}
