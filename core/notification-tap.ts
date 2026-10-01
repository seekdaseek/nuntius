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

/**
 * What identifies one tap. The notification id alone does not: pushes about
 * one permission share an id (the tray tag), so "Permission live" and a later
 * "received" have the same id and different urls.
 */
export function tapKey(response: TapResponse): string {
  return `${response.notification.request.identifier}|${tapUrl(response) ?? ''}`
}

/**
 * How a tap reached the app. One tap often arrives twice: on a cold start as
 * the launch response and again as a listener event; with the app open as the
 * forwarder activity's event and again through onNewIntent. `resume` is the
 * response the OS still holds when the app comes to the front, which catches a
 * tap whose listener event never arrived.
 */
export type TapSource = 'launch' | 'listener' | 'resume'

export interface TapDelivery {
  source: TapSource
  response: TapResponse
}

/**
 * Tap keys already routed in this process, oldest dropped first. It lives at
 * module scope so it outlasts a remount: after BACK finishes the activity and
 * the launcher starts it again in the same process, the old tap is not routed
 * a second time (device check, 1 Oct).
 */
export class TapLedger {
  private readonly max: number
  private readonly keys: string[] = []

  constructor(max = 64) {
    this.max = max
  }

  has(key: string): boolean {
    return this.keys.includes(key)
  }

  add(key: string): void {
    if (this.has(key)) return
    this.keys.push(key)
    if (this.keys.length > this.max) this.keys.shift()
  }
}

export type TapDecision =
  { routed: { id: string; key: string; url: string } } | { skipped: 'already-routed' | 'no-url'; key: string }

/**
 * What to do with one delivery. Only a key routed before is a repeat: each push
 * carries its own event in the url (kind, time, signature), so a second tap on
 * a later push about the same permission has a new key even though the tray id
 * is the same.
 */
export function decideTap(response: TapResponse, routed: Pick<TapLedger, 'has'>): TapDecision {
  const key = tapKey(response)
  if (routed.has(key)) return { skipped: 'already-routed', key }
  const url = tapUrl(response)
  if (!url) return { skipped: 'no-url', key }
  return { routed: { id: response.notification.request.identifier, key, url } }
}

/** Decides each delivery in order, recording every routed key in the ledger. */
export function routeDeliveries(
  deliveries: TapDelivery[],
  routed: TapLedger,
): { delivery: TapDelivery; decision: TapDecision }[] {
  return deliveries.map((delivery) => {
    const decision = decideTap(delivery.response, routed)
    if ('routed' in decision) routed.add(decision.routed.key)
    return { delivery, decision }
  })
}

/** One logcat line per delivery: "[tap] source id url -> routed|skipped(reason)". */
export function tapLogLine(delivery: TapDelivery, decision: TapDecision): string {
  const id = delivery.response.notification.request.identifier
  const url = tapUrl(delivery.response) ?? '-'
  const outcome = 'routed' in decision ? 'routed' : `skipped(${decision.skipped})`
  return `[tap] ${delivery.source} ${id} ${url} -> ${outcome}`
}
