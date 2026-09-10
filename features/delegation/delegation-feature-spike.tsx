import { Button, Text, View } from 'react-native'
import React from 'react'
import { appStyles } from '@/constants/app-styles'
import { ellipsify } from '@/utils/ellipsify'
import { isUserCancellation, type NuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useDelegationSpike } from '@/features/delegation/use-delegation-spike'

/**
 * Spike surface only (BRIEF-05 section 3): one button that asks Seed Vault to
 * authorize a recurring delegation on devnet. Not the product's rule UI.
 */
export function DelegationFeatureSpike({ auth }: { auth: NuntiusAuth }) {
  const spike = useDelegationSpike()
  const cancelled = spike.isError && isUserCancellation(spike.error)

  return (
    <View style={appStyles.stack}>
      <Text style={appStyles.tierLabel}>Delegation spike (devnet)</Text>
      <Button
        title={spike.isPending ? 'Awaiting Seed Vault…' : 'Authorize recurring delegation'}
        disabled={spike.isPending}
        onPress={() => spike.mutate(auth)}
      />
      {spike.isSuccess ? (
        <View style={appStyles.cardVerified}>
          <Text style={appStyles.tierLabel}>Delegation authorized</Text>
          <Text>authority tx {ellipsify(spike.data.authoritySignature, 6)}</Text>
          <Text>delegation tx {ellipsify(spike.data.delegationSignature, 6)}</Text>
          <Text>delegation {ellipsify(spike.data.delegationPda, 6)}</Text>
        </View>
      ) : null}
      {spike.isError ? (
        cancelled ? (
          <Text style={appStyles.hintText}>Approval dismissed. Tap to try again.</Text>
        ) : (
          <Text style={appStyles.errorText}>Delegation failed: {spike.error.message}</Text>
        )
      ) : null}
    </View>
  )
}
