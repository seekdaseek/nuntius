import { Linking, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'

/**
 * Evidence screen — what a notification opens.
 *
 * Never a bare number: it shows what moved, what is left this period, when the
 * cap resets, and a link out so the claim can be checked independently.
 */
export default function AlertScreen() {
  const { source, at, sig, moved, remaining, reset, pda } = useLocalSearchParams<{
    source?: string
    at?: string
    sig?: string
    moved?: string
    remaining?: string
    reset?: string
    pda?: string
  }>()

  const resetAt = reset ? new Date(Number(reset) * 1000) : null
  const explorer = sig ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : null

  return (
    <SafeAreaView style={appStyles.screen}>
      <View style={appStyles.stack}>
        <Text style={appStyles.title}>Alert</Text>

        {source === 'delegation' ? (
          <View style={appStyles.cardVerified}>
            <Text style={appStyles.tierLabel}>Delegated transfer executed</Text>
            <Text>Moved: {moved} tokens</Text>
            <Text>Remaining this period: {remaining} tokens</Text>
            <Text>Cap resets: {resetAt ? resetAt.toLocaleTimeString() : 'unknown'}</Text>
            <Text>Delegation: {pda}</Text>
            {explorer ? (
              <Text style={appStyles.linkText} onPress={() => void Linking.openURL(explorer)}>
                Verify on Solana Explorer
              </Text>
            ) : null}
          </View>
        ) : (
          <View style={appStyles.card}>
            <Text style={appStyles.tierLabel}>Opened from a push notification</Text>
            <Text>Source: {source ?? 'unknown'}</Text>
            <Text>Sent at: {at ?? 'unknown'}</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  )
}
