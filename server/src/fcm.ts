import { readFileSync } from 'node:fs'
import { JWT } from 'google-auth-library'

/**
 * FCM HTTP v1 sender. Auth is an OAuth bearer minted from the service-account
 * key via google-auth-library's JWT client, which caches the access token
 * internally until near expiry — no token is minted per send. The key never
 * leaves this process and is never logged.
 */
export class FcmSender {
  private readonly jwt: JWT
  private readonly endpoint: string

  constructor(keyFile: string, projectId: string) {
    const key = JSON.parse(readFileSync(keyFile, 'utf8')) as { client_email?: string; private_key?: string }
    if (!key.client_email || !key.private_key) {
      throw new Error('FCM service account file is missing client_email or private_key')
    }
    this.jwt = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    this.endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`
  }

  /**
   * Sends a data-only message so the app controls presentation via its
   * notification handler, and the same payload can drive background handling
   * later. expo-notifications reads title/message/channelId for display and
   * parses `body` (a JSON string) into the notification's data.
   */
  async send(token: string, data: Record<string, string>): Promise<{ ok: boolean; status: number; body: string }> {
    const { token: bearer } = await this.jwt.getAccessToken()
    if (!bearer) throw new Error('could not obtain FCM access token')

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ message: { token, data } }),
    })
    const body = await response.text()
    return { ok: response.ok, status: response.status, body }
  }
}
