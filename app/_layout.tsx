import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { AppProviders } from '@/components/app-providers'
import { useNotificationTapRouting } from '@/features/push/notification-routing'

export default function RootLayout() {
  useNotificationTapRouting()

  return (
    <AppProviders>
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* Screens carry their own large titles; the header only provides the back arrow. */}
        <Stack.Screen name="new" options={{ title: '', headerShadowVisible: false }} />
        <Stack.Screen name="receipts" options={{ title: '', headerShadowVisible: false }} />
        <Stack.Screen name="digest" options={{ title: '', headerShadowVisible: false }} />
        <Stack.Screen name="alert" options={{ title: '', headerShadowVisible: false }} />
      </Stack>
      <StatusBar style="auto" />
    </AppProviders>
  )
}
