import { useEffect, useRef } from 'react'
import { router, Stack, useRootNavigationState } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import 'react-native-reanimated'
import { AppProviders } from '@/components/app-providers'

/**
 * Tap-through: every notification carries a `url` in its data; tapping must land
 * on that screen. useLastNotificationResponse covers both the cold start (app
 * launched by the tap) and the warm case (response arriving while running).
 *
 * On a COLD start the response is already available on the first render, before
 * the root navigator has mounted, and a router.push() issued at that moment is
 * silently dropped — the app lands on index instead. Device-verified in a
 * RELEASE build 2026-09-10, so this is not the debug-build splash issue. Waiting
 * for the root navigation state's key is what makes the cold path land.
 */
function useNotificationTapRouting() {
  const response = Notifications.useLastNotificationResponse()
  const navigationState = useRootNavigationState()
  const routedId = useRef<string | null>(null)

  useEffect(() => {
    if (!navigationState?.key) return
    const request = response?.notification.request
    if (!request || routedId.current === request.identifier) return
    const url = request.content.data?.url
    // In-app paths only — never navigate anywhere a payload alone dictates.
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) {
      routedId.current = request.identifier
      router.push(url as never)
    }
  }, [response, navigationState?.key])
}

export default function RootLayout() {
  useNotificationTapRouting()

  return (
    <AppProviders>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="alert" options={{ title: 'Alert' }} />
      </Stack>
      <StatusBar style="auto" />
    </AppProviders>
  )
}
