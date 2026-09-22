import { ActivityIndicator, Button, Text, View } from 'react-native'
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { appStyles } from '@/constants/app-styles'
import { AppConfig } from '@/constants/app-config'
import { ellipsify } from '@/utils/ellipsify'
import { isUserCancellation, type NuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useDelegationRevoke, useDelegationSpike } from '@/features/delegation/use-delegation-spike'

interface DelegationState {
  cluster: 'devnet' | 'mainnet'
  exists: boolean
  delegationPda?: string
  mint?: string
  userAta?: string
  userAtaDelegate?: string | null
  userAtaDelegatedAmount?: string | null
  amountPerPeriod?: string
  amountPulledInPeriod?: string
  currentPeriodStartTs?: number
  periodLengthS?: number
}

/**
 * Delegation life cycle, device side: authorize, watch, revoke. The pulls in
 * between are signed by the delegatee alone and deliberately have no control
 * here — the user not being asked is the thing being demonstrated.
 */
export function DelegationFeatureSpike({ auth }: { auth: NuntiusAuth }) {
  const spike = useDelegationSpike()
  const revoke = useDelegationRevoke()
  const cancelled = spike.isError && isUserCancellation(spike.error)
  const revokeCancelled = revoke.isError && isUserCancellation(revoke.error)

  // Polled rather than pushed: this panel is the evidence surface, and a stale
  // reading here would be worse than a visibly loading one.
  const state = useQuery<DelegationState>({
    queryKey: ['delegation-state', auth.session, spike.data?.delegationPda, revoke.data?.revokeAuthoritySignature],
    refetchInterval: 5_000,
    queryFn: async () => {
      const response = await fetch(`${AppConfig.apiBase}/api/delegation/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: auth.session }),
      })
      const json = (await response.json()) as DelegationState & { ok: boolean; error?: string }
      if (!response.ok || !json.ok) throw new Error(json.error ?? `http ${response.status}`)
      return json
    },
  })

  const delegate = state.data?.userAtaDelegate ?? null
  const remaining =
    state.data?.amountPerPeriod && state.data.amountPulledInPeriod
      ? BigInt(state.data.amountPerPeriod) - BigInt(state.data.amountPulledInPeriod)
      : null

  return (
    <View style={appStyles.stack}>
      <Text style={appStyles.tierLabel}>Recurring delegation{state.data ? ` (${state.data.cluster})` : ''}</Text>

      <Button
        title={spike.isPending ? 'Awaiting Seed Vault…' : 'Authorize recurring delegation'}
        disabled={spike.isPending || revoke.isPending}
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

      {state.isLoading ? <ActivityIndicator /> : null}

      {state.data ? (
        <View style={appStyles.cardVerified}>
          <Text style={appStyles.tierLabel}>On-chain state</Text>
          <Text>delegation account {state.data.exists ? 'live' : 'closed'}</Text>
          {state.data.exists ? (
            <>
              <Text>cap {state.data.amountPerPeriod} base units / period</Text>
              <Text>pulled this period {state.data.amountPulledInPeriod}</Text>
              <Text>remaining {remaining === null ? '—' : remaining.toString()}</Text>
              <Text>period {state.data.periodLengthS}s</Text>
            </>
          ) : null}
          {/* The revoke proof lives here: after both revokes this must read none. */}
          <Text>userAta delegate {delegate ?? 'none'}</Text>
          {delegate ? <Text>delegated amount {state.data.userAtaDelegatedAmount ?? '—'}</Text> : null}
        </View>
      ) : null}

      <Button
        title={revoke.isPending ? 'Awaiting Seed Vault…' : 'Revoke (delegation, then authority)'}
        disabled={revoke.isPending || spike.isPending}
        onPress={() => revoke.mutate(auth)}
      />

      {revoke.isSuccess ? (
        <View style={appStyles.cardVerified}>
          <Text style={appStyles.tierLabel}>Revoked</Text>
          <Text>revokeDelegation {ellipsify(revoke.data.revokeDelegationSignature, 6)}</Text>
          <Text>revokeAuthority {ellipsify(revoke.data.revokeAuthoritySignature, 6)}</Text>
        </View>
      ) : null}

      {spike.isError ? (
        cancelled ? (
          <Text style={appStyles.hintText}>Approval dismissed. Tap to try again.</Text>
        ) : (
          <Text style={appStyles.errorText}>Delegation failed: {spike.error.message}</Text>
        )
      ) : null}
      {revoke.isError ? (
        revokeCancelled ? (
          <Text style={appStyles.hintText}>Approval dismissed. Tap to try again.</Text>
        ) : (
          <Text style={appStyles.errorText}>Revoke failed: {revoke.error.message}</Text>
        )
      ) : null}
    </View>
  )
}
