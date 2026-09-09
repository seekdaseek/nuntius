/**
 * Seeker Genesis Token (SGT) ownership check, per the documented Solana Mobile
 * verification path: page the wallet's Token-2022 accounts through Helius
 * getTokenAccountsByOwnerV2, then confirm a candidate mint carries the SGT
 * mint authority, metadata pointer and group membership.
 *
 * https://docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token
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

export interface SgtClassification {
  isMint: boolean
  mintAuthorityOk: boolean
  metadataPointerOk: boolean
  groupMemberOk: boolean
}

/** Per-check breakdown for one jsonParsed mint account, so a miss is diagnosable check by check. */
export function classifySgtMint(account: unknown): SgtClassification {
  const parsed = get(account, 'data', 'parsed')
  const info = get(parsed, 'info')
  const metadata = extensionState(info, 'metadataPointer')
  const member = extensionState(info, 'tokenGroupMember')
  return {
    isMint: get(parsed, 'type') === 'mint',
    mintAuthorityOk: get(info, 'mintAuthority') === SGT_MINT_AUTHORITY,
    metadataPointerOk:
      get(metadata, 'authority') === SGT_MINT_AUTHORITY && get(metadata, 'metadataAddress') === SGT_METADATA_ADDRESS,
    groupMemberOk: get(member, 'group') === SGT_GROUP_ADDRESS,
  }
}

export function isSgtMint(account: unknown): boolean {
  const c = classifySgtMint(account)
  return c.isMint && c.mintAuthorityOk && c.metadataPointerOk && c.groupMemberOk
}

export interface Token2022Account {
  mint: string
  amount: string
}

/** All of the owner's Token-2022 accounts, paged on paginationKey until absent. */
export async function fetchToken2022Accounts(
  rpcUrl: string,
  owner: string,
): Promise<{ accounts: Token2022Account[]; pages: number }> {
  const accounts: Token2022Account[] = []
  let paginationKey: string | null = null
  let pages = 0

  do {
    const result = await rpc(rpcUrl, 'getTokenAccountsByOwnerV2', [
      owner,
      { programId: TOKEN_2022_PROGRAM },
      { encoding: 'jsonParsed', limit: 1000, ...(paginationKey ? { paginationKey } : {}) },
    ])
    pages++
    const entries = get(result, 'value', 'accounts')
    for (const entry of Array.isArray(entries) ? entries : []) {
      const info = get(entry, 'account', 'data', 'parsed', 'info')
      const mint = get(info, 'mint')
      const amount = get(info, 'tokenAmount', 'amount')
      if (typeof mint === 'string') {
        accounts.push({ mint, amount: typeof amount === 'string' ? amount : '0' })
      }
    }
    const nextKey = get(result, 'paginationKey')
    paginationKey = typeof nextKey === 'string' ? nextKey : null
  } while (paginationKey)

  return { accounts, pages }
}

/** jsonParsed account infos for the given mints, batched 100 per getMultipleAccounts call. */
export async function fetchMintAccounts(rpcUrl: string, mints: string[]): Promise<unknown[]> {
  const results: unknown[] = []
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100)
    const result = await rpc(rpcUrl, 'getMultipleAccounts', [batch, { encoding: 'jsonParsed' }])
    const accounts = get(result, 'value')
    results.push(...(Array.isArray(accounts) ? accounts : batch.map(() => null)))
  }
  return results
}

/** Returns the SGT mint address the wallet holds, or null. Throws on RPC failure — fail closed, never fail open. */
export async function checkWalletForSgt(rpcUrl: string, owner: string): Promise<string | null> {
  const { accounts } = await fetchToken2022Accounts(rpcUrl, owner)

  // Transferring an SGT out leaves the old token account open with a balance of 0 — skip those.
  const candidateMints = accounts.filter((a) => a.amount !== '0').map((a) => a.mint)

  const mintAccounts = await fetchMintAccounts(rpcUrl, candidateMints)
  for (let i = 0; i < mintAccounts.length; i++) {
    if (isSgtMint(mintAccounts[i])) return candidateMints[i] ?? null
  }
  return null
}
