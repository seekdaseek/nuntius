import { Text, View } from 'react-native'
import React from 'react'
import { Button, theme } from '@/components/ui'
import { isUserCancellation, useSignInMutation } from '@/features/account/use-nuntius-auth'

export function AccountFeatureSignIn() {
  const signIn = useSignInMutation()
  // A dismissed wallet sheet is not a failure — the next tap opens it again — so
  // it gets a quiet hint, not a red error. Only real failures surface loudly.
  const cancelled = signIn.isError && isUserCancellation(signIn.error)

  return (
    <View style={{ gap: 8 }}>
      <Button
        title={signIn.isPending ? 'Approve in Seed Vault…' : 'Sign in with Solana'}
        busy={signIn.isPending}
        onPress={() => signIn.mutate()}
        testID="sign-in"
      />
      {signIn.isError ? (
        <Text style={{ color: cancelled ? theme.muted : theme.refused }}>
          {cancelled ? 'Sign-in dismissed. Tap to try again.' : `Sign-in failed: ${signIn.error.message}`}
        </Text>
      ) : null}
    </View>
  )
}
