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
   * Sends a notification + data message routed to a specific Android channel.
   *
   * Device-verified 2026-09-09: a DATA-ONLY message never reaches a killed app
   * without a background task (expo-task-manager), which is out of scope here —
   * FCM accepts it (200) but nothing is displayed. Since waking a killed phone
   * is the whole point of this product, the message carries a `notification`
   * block so the Android FCM SDK draws the tray notification itself in the
   * backgrounded and killed cases, with no app code running. `data` still rides
   * along for tap-through (`data.url`), and `android.notification.channel_id`
   * pins it to the HIGH-importance `alerts` channel so it wakes the device.
   */
  async send(
    token: string,
    notification: { title: string; body: string },
    channelId: string,
    data: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; body: string }> {
    const { token: bearer } = await this.jwt.getAccessToken()
    if (!bearer) throw new Error('could not obtain FCM access token')

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        message: {
          token,
          notification,
          data,
          android: { priority: 'HIGH', notification: { channel_id: channelId } },
        },
      }),
    })
    const body = await response.text()
    return { ok: response.ok, status: response.status, body }
  }
}
