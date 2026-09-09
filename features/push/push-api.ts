import { AppConfig } from '@/constants/app-config'

export async function postPushRegister(session: string, token: string, platform: string): Promise<void> {
  const response = await fetch(`${AppConfig.apiBase}/api/push/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session, token, platform }),
  })
  const body = (await response.json()) as { ok: boolean; error?: string }
  if (!response.ok || !body.ok) {
    throw new Error(`/api/push/register failed: ${body.error ?? `http ${response.status}`}`)
  }
}
