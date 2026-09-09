import { Button, Text, View } from 'react-native'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { useSignInMutation } from '@/features/account/use-nuntius-auth'

export function AccountFeatureSignIn() {
  const signIn = useSignInMutation()

  return (
    <View style={appStyles.stack}>
      <Button
        title={signIn.isPending ? 'Signing in…' : 'Sign in with Solana'}
        disabled={signIn.isPending}
        onPress={() => signIn.mutate()}
      />
      {signIn.isError ? <Text style={appStyles.errorText}>Sign-in failed: {signIn.error.message}</Text> : null}
    </View>
  )
}
