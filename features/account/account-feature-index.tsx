import { Button, Text, View } from 'react-native'
import React from 'react'
import { Address } from '@solana/kit'
import { AccountFeatureGetBalance } from '@/features/account/account-feature-get-balance'
import { AccountFeatureSignIn } from '@/features/account/account-feature-sign-in'
import { useNuntiusAuth, useSignOut, useVerifySeekerMutation } from '@/features/account/use-nuntius-auth'
import { usePushRegistration } from '@/features/push/use-push-registration'
import { appStyles } from '@/constants/app-styles'
import { ellipsify } from '@/utils/ellipsify'
import { DelegationFeatureSpike } from '@/features/delegation/delegation-feature-spike'

export function AccountFeatureIndex() {
  const auth = useNuntiusAuth()
  usePushRegistration(auth)

  return (
    <View style={appStyles.stack}>
      <Text style={appStyles.title}>Account</Text>
      {auth ? <SignedIn /> : <SignedOut />}
    </View>
  )
}

/** State 1 — disconnected: one tap starts SIWS; the wallet picks the account in the same prompt. */
function SignedOut() {
  return (
    <View style={appStyles.stack}>
      <View style={appStyles.card}>
        <Text>Not signed in</Text>
        <Text>Sign in with your wallet. Seeker owners unlock the full tier.</Text>
      </View>
      <AccountFeatureSignIn />
    </View>
  )
}

function SignedIn() {
  const auth = useNuntiusAuth()
  const verifySeeker = useVerifySeekerMutation()
  const signOut = useSignOut()
  if (!auth) return null

  const verified = auth.sgtMint !== null

  return (
    <View style={appStyles.stack}>
      <View style={verified ? appStyles.cardVerified : appStyles.card}>
        <Text style={appStyles.tierLabel}>{verified ? 'Seeker verified — full tier' : 'Signed in — basic tier'}</Text>
        <Text>Wallet {ellipsify(auth.address)}</Text>
        <AccountFeatureGetBalance address={auth.address as Address} />
        {verified ? (
          <Text>Genesis Token {ellipsify(auth.sgtMint ?? '')}</Text>
        ) : (
          <Text>Verify Seeker ownership to unlock the full tier.</Text>
        )}
      </View>
      {/* State 2 — signed in, not Seeker-verified: the path to the full tier. */}
      {!verified ? (
        <View style={appStyles.stack}>
          <Button
            title={verifySeeker.isPending ? 'Verifying…' : 'Verify Seeker ownership'}
            disabled={verifySeeker.isPending}
            onPress={() => verifySeeker.mutate(auth)}
          />
          {verifySeeker.isError ? (
            <Text style={appStyles.errorText}>Verification failed: {verifySeeker.error.message}</Text>
          ) : verifySeeker.isSuccess && verifySeeker.data.sgtMint === null ? (
            <Text style={appStyles.errorText}>No Seeker Genesis Token found for this wallet.</Text>
          ) : null}
        </View>
      ) : null}
      <DelegationFeatureSpike auth={auth} />
      <Button title="Sign out" onPress={() => void signOut()} />
    </View>
  )
}
