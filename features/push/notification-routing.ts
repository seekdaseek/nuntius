import { useEffect, useRef } from 'react'
import { AppState, Platform } from 'react-native'
import { router, useRootNavigationState } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { tapTarget } from '@/core/notification-tap'
import { useTapResponse } from '@/features/push/use-tap-response'

/**
 * Tap-through: every notification carries a `url` in its data; tapping must land
 * on that screen, with the app open, in the background, or killed.
 *
 * Mount this only after the root Stack has rendered (see app/_layout.tsx). On a
 * cold start from a tap the response is already there on the first render. When
 * this ran in the root layout while the layout still rendered nothing (fonts
 * loading), router.push() went to a navigator that did not exist yet and React
 * gave up with "Maximum update depth exceeded" (device check 7, 30 Sep;
 * reproduced by e2e/cold-start-tap.test.mjs). Mounted after the Stack, the first
 * push has somewhere to land.
 *
 * The tray is cleared whenever the app comes to the front. When an app has
 * several notifications showing, Android folds them into one collapsed group,
 * and a tap on the group opens the app with no notification's data, so it
 * cannot land anywhere (device check 5, 30 Sep and 1 Oct). The server tags
 * pushes per permission, in the Android payload and in data, so a newer one
 * replaces an older one whether Android or the open app draws it.
 */
export function useNotificationTapRouting() {
  const response = useTapResponse()
  const navigationState = useRootNavigationState()
  const routedId = useRef<string | null>(null)

  useEffect(() => {
    if (!navigationState?.key) return
    const target = tapTarget(response, routedId.current)
    if (!target) return
    routedId.current = target.key
    router.push(target.url as never)
    if (Platform.OS !== 'web') Notifications.dismissNotificationAsync(target.id).catch(() => {})
  }, [response, navigationState?.key])

  useEffect(() => {
    if (Platform.OS === 'web') return
    const clear = () => Notifications.dismissAllNotificationsAsync().catch(() => {})
    clear()
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') clear()
    })
    return () => sub.remove()
  }, [])
}

/** Renders nothing; routes notification taps. */
export function NotificationTapRouter() {
  useNotificationTapRouting()
  return null
}
