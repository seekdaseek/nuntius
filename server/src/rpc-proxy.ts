/**
 * Allowlisted JSON-RPC proxy in front of the Helius key, so the key lives in
 * exactly one process and never in the app bundle. Forwards single requests
 * whose method is explicitly allowed; batches and everything else are rejected.
 */

/** The read methods the client actually calls. Extend deliberately, never wildcard. */
const ALLOWED_METHODS = new Set(['getBalance', 'getVersion', 'getGenesisHash', 'getLatestBlockhash'])

export interface RpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown[]
}

/** Validate an incoming body as a single allowlisted JSON-RPC request. Null means reject. */
export function parseRpcRequest(body: unknown): RpcRequest | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const v = body as Record<string, unknown>
  if (v.jsonrpc !== '2.0') return null
  if (typeof v.id !== 'string' && typeof v.id !== 'number') return null
  if (typeof v.method !== 'string' || !ALLOWED_METHODS.has(v.method)) return null
  if (v.params !== undefined && !Array.isArray(v.params)) return null
  return { jsonrpc: '2.0', id: v.id, method: v.method, params: v.params as unknown[] | undefined }
}

export async function forwardRpc(rpcUrl: string, request: RpcRequest): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(`rpc http ${response.status}`)
  return response.json()
}
