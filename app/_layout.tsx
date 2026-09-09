import { useEffect } from 'react'
import { router, Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as Notifications from 'expo-notifications'
import 'react-native-reanimated'
import { AppProviders } from '@/components/app-providers'

/**
 * Tap-through: every notification carries a `url` in its data; tapping must land
 * on that screen. useLastNotificationResponse covers both the cold start (app
 * launched by the tap) and the warm case (response arriving while running).
 */
function useNotificationTapRouting() {
  const response = Notifications.useLastNotificationResponse()

  useEffect(() => {
    const url = response?.notification.request.content.data?.url
    // In-app paths only — never navigate anywhere a payload alone dictates.
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//')) {
      router.push(url as never)
    }
  }, [response])
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
