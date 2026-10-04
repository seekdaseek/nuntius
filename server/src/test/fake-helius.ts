import type { Fetch } from '../program-accounts.js'

/** A fake Helius: getProgramAccountsV2 only, `perPage` accounts a page, and every request kept. */
export function fakeHelius(accounts: { pubkey: string; data: string; owner: string }[], perPage: number) {
  const calls: { method: string; params: unknown[] }[] = []
  const doFetch: Fetch = async (_url, init) => {
    const req = JSON.parse(init.body) as { id: string; method: string; params: unknown[] }
    calls.push(req)
    if (req.method !== 'getProgramAccountsV2') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: -32600,
            message:
              'Request deprioritized due to number of accounts requested. Please use getProgramAccountsV2 with pagination',
          },
        }),
      }
    }
    const cfg = req.params[1] as { paginationKey?: string }
    const start = cfg.paginationKey ? Number(cfg.paginationKey) : 0
    const page = accounts.slice(start, start + perPage)
    const next = start + perPage < accounts.length ? String(start + perPage) : null
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          accounts: page.map((a) => ({
            pubkey: a.pubkey,
            account: {
              data: [a.data, 'base64'],
              executable: false,
              lamports: 2_000_000,
              owner: a.owner,
              rentEpoch: 0,
              space: 0,
            },
          })),
          paginationKey: next,
        },
      }),
    }
  }
  return { calls, doFetch }
}
