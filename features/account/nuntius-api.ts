import { AppConfig } from '@/constants/app-config'

/** SIWS payload as issued by GET /api/siws-payload. Signed as-is; never modified client-side. */
export interface SiwsPayload {
  domain: string
  uri: string
  statement: string
  nonce: string
  issuedAt: string
  expirationTime: string
}

/** MWA sign_in_result wire shape the backend verifies: base64 address, signed_message, signature. */
export interface WireSignInResult {
  address: string
  signed_message: string
  signature: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${AppConfig.apiBase}${path}`, init)
  const body = (await response.json()) as T & { ok: boolean; error?: string }
  if (!response.ok || !body.ok) {
    throw new Error(`${path} failed: ${body.error ?? `http ${response.status}`}`)
  }
  return body
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export async function getSiwsPayload(): Promise<SiwsPayload> {
  const { payload } = await request<{ payload: SiwsPayload }>('/api/siws-payload')
  return payload
}

export function postSiwsVerify(nonce: string, signInResult: WireSignInResult): Promise<{ address: string; session: string }> {
  return post('/api/siws-verify', { nonce, signInResult })
}

export function postVerifySeeker(session: string): Promise<{ sgtMint: string | null }> {
  return post('/api/verify-seeker', { session })
}
