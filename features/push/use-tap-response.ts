import { useLayoutEffect, useState } from 'react'
import * as Notifications from 'expo-notifications'
import type { TapResponse } from '@/core/notification-tap'

/**
 * Every notification tap: the one that launched the app (cold start), then each
 * one after. Not useLastNotificationResponse: it ignores a response whose id it
 * has already seen, and pushes about one permission share an id (their tray
 * tag), so a "received" tapped after "Permission live" would never arrive.
 * Repeats of one tap are filtered by tapTarget's key.
 */
export function useTapResponse(): TapResponse | null {
  const [tap, setTap] = useState<TapResponse | null>(null)
  useLayoutEffect(() => {
    const last = Notifications.getLastNotificationResponse()
    if (last) setTap(last as TapResponse)
    const sub = Notifications.addNotificationResponseReceivedListener((r) => setTap(r as TapResponse))
    return () => sub.remove()
  }, [])
  return tap
}
