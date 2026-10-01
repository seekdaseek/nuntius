import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { useFonts } from 'expo-font'
import { BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque'
import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold } from '@expo-google-fonts/figtree'
import 'react-native-reanimated'
import { AppProviders } from '@/components/app-providers'
import { NotificationTapRouter } from '@/features/push/notification-routing'
import { FontGate, FontsReady } from '@/features/fonts/fonts-ready'
import { color } from '@/constants/app-styles'

// Keep the signal splash up until the fonts are in: no flash of system type.
void SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout() {
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

  // The Stack renders from the first frame, fonts or not: the splash covers it
  // until they are in. A root layout that renders nothing leaves a notification
  // tap on a cold start with no navigator to land in (device check 7). Each
  // screen's content waits for the fonts (FontGate), so no text is measured
  // with the fallback font (device check 11, 1 Oct).
  return (
    <FontsReady.Provider value={ready}>
      <AppProviders>
        {/* Screens draw their own back arrow and titles, as in the design. */}
        <Stack
          screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.paper } }}
          screenLayout={({ children }) => <FontGate>{children}</FontGate>}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="new" />
          <Stack.Screen name="receipts" />
          <Stack.Screen name="digest" />
          <Stack.Screen name="alert" />
        </Stack>
        <StatusBar style="auto" />
        {/* After the Stack, so the first push after a cold start has a screen to open. */}
        {ready ? <NotificationTapRouter /> : null}
      </AppProviders>
    </FontsReady.Provider>
  )
}
