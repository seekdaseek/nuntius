import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { useFonts } from 'expo-font'
import { BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque'
import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold } from '@expo-google-fonts/figtree'
import 'react-native-reanimated'
import { AppProviders } from '@/components/app-providers'
import { useNotificationTapRouting } from '@/features/push/notification-routing'
import { color } from '@/constants/app-styles'

// Keep the signal splash up until the fonts are in: no flash of system type.
void SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
  useNotificationTapRouting()
  const [loaded, error] = useFonts({
    BricolageGrotesque_800ExtraBold,
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_600SemiBold,
    Figtree_700Bold,
  })
  const ready = loaded || Boolean(error)

  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {})
  }, [ready])

  if (!ready) return null

  return (
    <AppProviders>
      {/* Screens draw their own back arrow and titles, as in the design. */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.paper } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="new" />
        <Stack.Screen name="receipts" />
        <Stack.Screen name="digest" />
        <Stack.Screen name="alert" />
      </Stack>
      <StatusBar style="auto" />
    </AppProviders>
  )
}
