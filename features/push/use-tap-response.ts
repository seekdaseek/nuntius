import { useLayoutEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as Notifications from 'expo-notifications'
import type { TapDelivery, TapResponse, TapSource } from '@/core/notification-tap'

/**
 * Every delivery of a notification tap, queued in order: the response that
 * launched the app (cold start), each one the listener reports, and on every
 * return to the front the response the OS still holds. That last one catches a
 * tap whose listener event never arrived (device check 6, 1 Oct: a refused push
 * the server sent once, tapped with the app open, opened nothing). Repeats of
 * one tap are dropped by the router's ledger, never a second tap.
 *
 * Not useLastNotificationResponse: it ignores a response whose id it has already
 * seen, and pushes about one permission share an id (their tray tag).
 */
export function useTapDeliveries(): { queue: { current: TapDelivery[] }; tick: number } {
  const queue = useRef<TapDelivery[]>([])
  const [tick, setTick] = useState(0)
  useLayoutEffect(() => {
    const deliver = (source: TapSource, response: TapResponse) => {
      queue.current.push({ source, response })
      setTick((t) => t + 1)
    }
    const held = (source: TapSource) => {
      const last = Notifications.getLastNotificationResponse()
      if (last) deliver(source, last as TapResponse)
    }
    held('launch')
    const sub = Notifications.addNotificationResponseReceivedListener((r) => deliver('listener', r as TapResponse))
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') held('resume')
    })
    return () => {
      sub.remove()
      app.remove()
    }
  }, [])
  return { queue, tick }
}
