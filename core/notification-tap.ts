/**
 * Where a notification tap should land. Every nuntius push carries `url` in its
 * FCM data. expo-notifications hands it over as `content.data` when the app
 * shows the notification itself (open) and when the tray's notification is
 * tapped (background, killed); on Android the raw FCM message may also be under
 * `trigger.remoteMessage.data`. Both are read, and only in-app paths are
 * accepted: a payload alone never sends the app anywhere else.
 */
export interface TapResponse {
  notification: {
    request: {
      identifier: string
      content: { data?: Record<string, unknown> | null }
      trigger?: unknown
    }
  }
}

const ROUTES = ['/', '/alert', '/receipts', '/digest', '/new']

export function tapUrl(response: TapResponse): string | null {
  const request = response.notification.request
  const trigger = request.trigger as { remoteMessage?: { data?: Record<string, unknown> } } | null | undefined
  const candidates = [request.content.data?.url, trigger?.remoteMessage?.data?.url]
  for (const url of candidates) {
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) continue
    const path = url.split('?')[0]!
    if (ROUTES.includes(path)) return url
  }
  return null
}

/** The screen to open for a tap, or null when there is nothing (new) to open. */
export function tapTarget(
  response: TapResponse | null | undefined,
  alreadyRouted: string | null,
): { id: string; url: string } | null {
  if (!response) return null
  const id = response.notification.request.identifier
  if (id === alreadyRouted) return null
  const url = tapUrl(response)
  return url ? { id, url } : null
}
