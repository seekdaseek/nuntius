import { Button, Text, View } from 'react-native'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { isUserCancellation, useSignInMutation } from '@/features/account/use-nuntius-auth'

export function AccountFeatureSignIn() {
  const signIn = useSignInMutation()
  // A dismissed wallet sheet is not a failure — the next tap opens it again — so
  // it gets a quiet hint, not a red error. Only real failures surface loudly.
  const cancelled = signIn.isError && isUserCancellation(signIn.error)

  return (
    <View style={appStyles.stack}>
      <Button
        title={signIn.isPending ? 'Signing in…' : 'Sign in with Solana'}
        disabled={signIn.isPending}
        onPress={() => signIn.mutate()}
      />
      {signIn.isError ? (
        cancelled ? (
          <Text style={appStyles.hintText}>Sign-in dismissed. Tap to try again.</Text>
        ) : (
          <Text style={appStyles.errorText}>Sign-in failed: {signIn.error.message}</Text>
        )
      ) : null}
    </View>
  )
}
