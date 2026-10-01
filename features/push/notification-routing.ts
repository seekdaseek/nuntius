import { useEffect } from 'react'
import { AppState, Platform } from 'react-native'
import { router, useRootNavigationState } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { routeDeliveries, staleTrayIds, TapLedger, tapLogLine } from '@/core/notification-tap'
import { isSingleScreen } from '@/core/routes'
import { useTapDeliveries } from '@/features/push/use-tap-response'

/** Taps routed in this process. Module scope: a remount must not route an old tap again. */
const routed = new TapLedger()

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
  const { queue, tick } = useTapDeliveries()
  const navigationState = useRootNavigationState()

  useEffect(() => {
    if (!navigationState?.key) return
    for (const { delivery, decision } of routeDeliveries(queue.current.splice(0), routed)) {
      console.log(tapLogLine(delivery, decision))
      // Handled either way: the OS must not hand this response back on the next
      // mount or return to the front (device check, 1 Oct: BACK, then the
      // launcher, reopened the last receipt).
      if (Platform.OS !== 'web') Notifications.clearLastNotificationResponse()
      if (!('routed' in decision)) continue
      const target = decision.routed
      // Clock in, the receipts list and home are single screens: a tap that opens
      // one already open must not stack a second copy, or BACK lands on the first
      // (device check 10, 1 Oct). Receipts each get their own screen.
      router.push(target.url as never, isSingleScreen(target.url) ? { dangerouslySingular: true } : undefined)
      if (Platform.OS !== 'web') Notifications.dismissNotificationAsync(target.id).catch(() => {})
    }
  }, [queue, tick, navigationState?.key])

  useEffect(() => {
    if (Platform.OS === 'web') return
    const clear = () => Notifications.dismissAllNotificationsAsync().catch(() => {})
    clear()
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') clear()
    })
    // With the app open, a new push leaves the tray holding only itself, so
    // Android never folds two of ours into a group whose tap carries no url.
    const received = Notifications.addNotificationReceivedListener((n) => {
      if (AppState.currentState !== 'active') return
      const newest = n.request.identifier
      Notifications.getPresentedNotificationsAsync()
        .then((shown) => {
          const stale = staleTrayIds(
            shown.map((s) => s.request.identifier),
            newest,
          )
          console.log(`[tray] ${newest} newest, dismissed ${stale.length}`)
          for (const id of stale) Notifications.dismissNotificationAsync(id).catch(() => {})
        })
        .catch(() => {})
    })
    return () => {
      sub.remove()
      received.remove()
    }
  }, [])
}

/** Renders nothing; routes notification taps. */
export function NotificationTapRouter() {
  useNotificationTapRouting()
  return null
}
