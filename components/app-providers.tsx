import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PropsWithChildren } from 'react'
import * as Notifications from 'expo-notifications'
import { NetworkProvider } from '@/features/network/network-provider'
import { MobileWalletProvider } from '@wallet-ui/react-native-kit'
import { AppConfig } from '@/constants/app-config'

// Module scope so it is set before anything renders. Messages are sent
// data-only, so presentation is decided here, not by the sender.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

const queryClient = new QueryClient()
export function AppProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      <NetworkProvider
        networks={AppConfig.networks}
        render={({ selectedNetwork }) => (
          <MobileWalletProvider cluster={selectedNetwork} identity={AppConfig.identity}>
            {children}
          </MobileWalletProvider>
        )}
      />
    </QueryClientProvider>
  )
}
