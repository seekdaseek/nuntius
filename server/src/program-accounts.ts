/**
 * getProgramAccounts that works on Helius. Since 1 Oct, Helius answers an unpaginated
 * getProgramAccounts with "Request deprioritized due to number of accounts requested.
 * Please use getProgramAccountsV2 with pagination" (the guard's delegator scan failed on
 * mainnet 13:42-13:44Z). On a Helius URL every getProgramAccounts goes out as
 * getProgramAccountsV2 with the same filters, paged on paginationKey until it is absent.
 * Any other RPC (localnet, a test validator) gets the plain call, unchanged.
 *
 * Two adapters, one per client in the server: the kit Rpc (the guard, the permission list,
 * grants, revokes) and the web3.js Connection the Meteora SDKs read through (the DAMM v2
 * pool lookup after migration).
 */
import { PublicKey, type Connection } from '@solana/web3.js'
import type { Rpc } from './tx.js'

export function isHelius(rpcUrl: string): boolean {
  try {
    return /(^|\.)helius-rpc\.com$|(^|\.)helius\.xyz$/.test(new URL(rpcUrl).hostname)
  } catch {
    return false
  }
}

/** One account as getProgramAccounts returns it with base64 encoding (JSON, before any client decoding). */
export interface RawProgramAccount {
  pubkey: string
  account: {
    data: [string, 'base64']
    executable: boolean
    lamports: number
    owner: string
    rentEpoch?: number
    space?: number
  }
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export const V2_PAGE = 1000

/** Filters as JSON: kit hands memcmp offsets and dataSize as bigint. */
function plainFilters(filters: unknown): unknown {
  return JSON.parse(JSON.stringify(filters ?? [], (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v)))
}

/** Every account of the program matching the filters, paged on paginationKey until absent. */
export async function programAccountsV2(
  rpcUrl: string,
  program: string,
  filters: unknown,
  doFetch: Fetch = fetch as unknown as Fetch,
): Promise<RawProgramAccount[]> {
  const out: RawProgramAccount[] = []
  let paginationKey: string | null = null
  let page = 0
  do {
    const res = await doFetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `gpa2-${page++}`,
        method: 'getProgramAccountsV2',
        params: [
          program,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            filters: plainFilters(filters),
            limit: V2_PAGE,
            ...(paginationKey ? { paginationKey } : {}),
          },
        ],
      }),
    })
    if (!res.ok) throw new Error(`getProgramAccountsV2: HTTP ${res.status}`)
    const body = (await res.json()) as {
      error?: { message?: string }
      result?: { accounts?: RawProgramAccount[]; paginationKey?: string | null }
    }
    if (body.error) throw new Error(`getProgramAccountsV2: ${body.error.message ?? 'error'}`)
    if (!body.result || !Array.isArray(body.result.accounts)) throw new Error('getProgramAccountsV2: no accounts')
    out.push(...body.result.accounts)
    paginationKey = typeof body.result.paginationKey === 'string' ? body.result.paginationKey : null
    if (page > 1000) throw new Error('getProgramAccountsV2: too many pages')
  } while (paginationKey)
  return out
}

/**
 * The kit Rpc with getProgramAccounts answered by getProgramAccountsV2 on Helius. Callers
 * (the @solana/subscriptions fetchers) keep their own filters and decoding.
 */
export function withPagedProgramAccounts(rpc: Rpc, rpcUrl: string, doFetch?: Fetch): Rpc {
  if (!isHelius(rpcUrl)) return rpc
  const getProgramAccounts = (program: string, config?: { encoding?: string; filters?: unknown }) => ({
    send: async () => {
      if (config?.encoding && config.encoding !== 'base64') throw new Error('paged getProgramAccounts: base64 only')
      return (await programAccountsV2(rpcUrl, program, config?.filters, doFetch)).map((a) => ({
        pubkey: a.pubkey,
        account: { ...a.account, lamports: BigInt(a.account.lamports), space: BigInt(a.account.space ?? 0) },
      }))
    },
  })
  return new Proxy(rpc, {
    get: (target, prop, receiver) =>
      prop === 'getProgramAccounts' ? getProgramAccounts : Reflect.get(target, prop, receiver),
  })
}

/** The same for a web3.js Connection, in place: Anchor's account.all() calls connection.getProgramAccounts. */
export function pageConnection(conn: Connection, doFetch?: Fetch): Connection {
  if (!isHelius(conn.rpcEndpoint)) return conn
  const paged = async (program: PublicKey, config?: { filters?: unknown }) =>
    (await programAccountsV2(conn.rpcEndpoint, program.toBase58(), config?.filters, doFetch)).map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      account: {
        data: Buffer.from(a.account.data[0], 'base64'),
        executable: a.account.executable,
        lamports: a.account.lamports,
        owner: new PublicKey(a.account.owner),
        rentEpoch: a.account.rentEpoch,
      },
    }))
  ;(conn as unknown as { getProgramAccounts: typeof paged }).getProgramAccounts = paged
  return conn
}
