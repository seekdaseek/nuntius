import React from 'react'
import { View } from 'react-native'
import { Button, Note } from '@/components/ui'
import { isUserCancellation, useSignInMutation } from '@/features/account/use-nuntius-auth'

export function AccountFeatureSignIn() {
  const signIn = useSignInMutation()
  // A dismissed wallet sheet is not a failure — the next tap opens it again — so
  // it gets a quiet note, not a red error. Only real failures surface loudly.
  const cancelled = signIn.isError && isUserCancellation(signIn.error)

  return (
    <View style={{ gap: 10, marginTop: 8 }}>
      <Button
        big
        title={signIn.isPending ? 'Waiting for Seed Vault' : 'Sign in with Solana'}
        busy={signIn.isPending}
        onPress={() => signIn.mutate()}
        testID="sign-in"
      />
      {signIn.isError ? (
        <Note tone={cancelled ? 'foreign' : 'refused'}>
          {cancelled ? 'Sign-in dismissed. Tap to try again.' : `Sign-in failed: ${signIn.error.message}`}
        </Note>
      ) : null}
    </View>
  )
}
