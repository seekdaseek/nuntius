import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { router, useRootNavigationState } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { tapTarget } from '@/core/notification-tap'

/**
 * Tap-through: every notification carries a `url` in its data; tapping must land
 * on that screen, with the app open, in the background, or killed.
 * useLastNotificationResponse covers all three: the response is already there
 * on the first render after a cold start, and arrives as an event otherwise.
 *
 * On a COLD start the response is already available on the first render, before
 * the root navigator has mounted, and a router.push() issued at that moment is
 * silently dropped — the app lands on index instead. Device-verified in a
 * RELEASE build 2026-09-10. Waiting for the root navigation state's key is what
 * makes the cold path land.
 *
 * The tray is cleared whenever the app comes to the front. When an app has
 * several notifications showing, Android folds them into one collapsed group,
 * and a tap on the group opens the app with no notification's data, so it
 * cannot land anywhere (device checks 5 and 8, 30 Sep: "received" pushes were
 * tapped from such a group; the refusal that worked was tapped on its own).
 * The server also tags pushes per permission, so a newer one replaces an older.
 */
export function useNotificationTapRouting() {
  const response = Notifications.useLastNotificationResponse()
  const navigationState = useRootNavigationState()
  const routedId = useRef<string | null>(null)

  useEffect(() => {
    if (!navigationState?.key) return
    const target = tapTarget(response, routedId.current)
    if (!target) return
    routedId.current = target.id
    router.push(target.url as never)
    Notifications.dismissNotificationAsync(target.id).catch(() => {})
  }, [response, navigationState?.key])

  useEffect(() => {
    const clear = () => Notifications.dismissAllNotificationsAsync().catch(() => {})
    clear()
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') clear()
    })
    return () => sub.remove()
  }, [])
}
