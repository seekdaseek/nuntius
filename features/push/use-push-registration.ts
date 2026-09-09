import { useEffect } from 'react'
import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import { postPushRegister } from '@/features/push/push-api'
import type { NuntiusAuth } from '@/features/account/use-nuntius-auth'

/**
 * Registers this device for push once a session exists.
 *
 * Order is load-bearing on Android 13+: the OS permission prompt will not appear
 * until at least one notification channel exists, and setNotificationChannelAsync
 * must run before getDevicePushTokenAsync — otherwise the failure is silent.
 */
export function usePushRegistration(auth: NuntiusAuth | null) {
  const session = auth?.session ?? null

  useEffect(() => {
    if (!session) return
    let cancelled = false

    async function register(session: string) {
      // 1. Channels first. Two for now: alerts wake the phone, digest stays quiet.
      // Per-rule channels arrive with the rule engine.
      await Notifications.setNotificationChannelAsync('alerts', {
        name: 'Alerts',
        importance: Notifications.AndroidImportance.HIGH,
      })
      await Notifications.setNotificationChannelAsync('digest', {
        name: 'Daily digest',
        importance: Notifications.AndroidImportance.DEFAULT,
      })

      // 2. Permission — prompts on Android 13+ now that a channel exists.
      const current = await Notifications.getPermissionsAsync()
      const granted = current.granted ? current : await Notifications.requestPermissionsAsync()
      if (!granted.granted) {
        console.log('push: notification permission not granted')
        return
      }

      // 3. Native FCM token — we own the backend and the Firebase project, so we
      // talk to FCM directly; no Expo push service in the delivery path.
      const token = await Notifications.getDevicePushTokenAsync()
      if (cancelled) return
      if (__DEV__) console.log(`push: device token ${String(token.data).slice(0, 12)}…`)

      // 4. Bind the token to this session's identity server-side.
      await postPushRegister(session, String(token.data), Platform.OS)
      if (__DEV__) console.log('push: token registered with backend')
    }

    register(session).catch((error: unknown) => {
      console.log(`push: registration failed: ${error instanceof Error ? error.message : 'unknown'}`)
    })

    // The service can roll the token while the app runs; the old one silently
    // stops delivering. Re-register whenever it fires.
    const tokenSub = Notifications.addPushTokenListener((token) => {
      postPushRegister(session, String(token.data), Platform.OS).catch(() => {
        console.log('push: token rotation re-registration failed')
      })
    })
    // Maps to FCM onDeletedMessages: the server dropped queued messages.
    const droppedSub = Notifications.addNotificationsDroppedListener(() => {
      console.log('push: FCM reported dropped notifications')
    })

    return () => {
      cancelled = true
      tokenSub.remove()
      droppedSub.remove()
    }
  }, [session])
}
