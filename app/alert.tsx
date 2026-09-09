import { Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import React from 'react'
import { appStyles } from '@/constants/app-styles'

/**
 * Tap-through target. In the finished product this is the evidence screen:
 * what was measured, when, and the Solscan link — never a bare number.
 * For now it renders what the notification carried, proving the route.
 */
export default function AlertScreen() {
  const { source, at } = useLocalSearchParams<{ source?: string; at?: string }>()

  return (
    <SafeAreaView style={appStyles.screen}>
      <View style={appStyles.stack}>
        <Text style={appStyles.title}>Alert</Text>
        <View style={appStyles.card}>
          <Text style={appStyles.tierLabel}>Opened from a push notification</Text>
          <Text>Source: {source ?? 'unknown'}</Text>
          <Text>Sent at: {at ?? 'unknown'}</Text>
        </View>
      </View>
    </SafeAreaView>
  )
}
