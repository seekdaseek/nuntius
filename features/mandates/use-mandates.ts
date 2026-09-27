import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import type { NuntiusAuth } from '@/features/account/use-nuntius-auth'
import { api, untilLanded, type TermsInput } from '@/features/mandates/mandates-api'
import { signAndSend } from '@/features/wallet/sign-and-send'
import { refreshWidget } from '@/features/widget/refresh-widget'
import { tzOffsetMin } from '@/core/format'

const KEY = ['mandates']

export function useMandateList(auth: NuntiusAuth | null) {
  return useQuery({
    queryKey: [...KEY, 'list', auth?.session],
    enabled: Boolean(auth),
    // Polled: this is the evidence surface, and a stale cap reading is worse than a spinner.
    refetchInterval: 10_000,
    queryFn: () => api.list(auth!.session),
  })
}

export function useReceipts(auth: NuntiusAuth | null) {
  return useQuery({
    queryKey: [...KEY, 'receipts', auth?.session],
    enabled: Boolean(auth),
    refetchInterval: 15_000,
    queryFn: () => api.receipts(auth!.session),
  })
}

export function useDigest(auth: NuntiusAuth | null) {
  return useQuery({
    queryKey: [...KEY, 'digest', auth?.session],
    enabled: Boolean(auth),
    queryFn: () => api.digest(auth!.session, tzOffsetMin()),
  })
}

function useAfterChange(auth: NuntiusAuth | null) {
  const qc = useQueryClient()
  return async () => {
    await qc.invalidateQueries({ queryKey: KEY })
    if (auth) void refreshWidget(auth.session)
  }
}

export type GrantStep = 'building' | 'signing' | 'confirming'

/**
 * The whole grant: the server builds ONE transaction (init + create), Seed Vault
 * signs it once, the server confirms the chain matches the terms exactly.
 */
export function useGrantMandate(auth: NuntiusAuth | null, onStep?: (s: GrantStep) => void) {
  const { chain, identity } = useMobileWallet()
  const after = useAfterChange(auth)
  return useMutation({
    mutationFn: async (terms: TermsInput) => {
      if (!auth) throw new Error('not signed in')
      onStep?.('building')
      const created = await api.create(auth.session, terms)
      onStep?.('signing')
      const signature = await signAndSend(chain, identity, created.transactionBase64)
      onStep?.('confirming')
      const confirmed = await untilLanded(() => api.confirm(auth.session, created.mandateId), ['not_on_chain_yet'])
      return { signature, mandate: confirmed.mandate }
    },
    onSuccess: after,
  })
}

/** One signature ends any fixed or recurring delegation on the wallet, whoever holds it. */
export function useRevoke(auth: NuntiusAuth | null) {
  const { chain, identity } = useMobileWallet()
  const after = useAfterChange(auth)
  return useMutation({
    mutationFn: async (delegationPda: string) => {
      if (!auth) throw new Error('not signed in')
      const tx = await api.revoke(auth.session, delegationPda)
      const signature = await signAndSend(chain, identity, tx.transactionBase64)
      const done = await untilLanded(() => api.revokeConfirm(auth.session, delegationPda), ['still_live'])
      return { signature, ...done, revokesAuthority: tx.revokesAuthority }
    },
    onSuccess: after,
  })
}

export function useClockIn(auth: NuntiusAuth | null) {
  const after = useAfterChange(auth)
  return useMutation({
    mutationFn: () => api.clockIn(auth!.session, tzOffsetMin()),
    onSuccess: after,
  })
}

export function useDigestPrefs(auth: NuntiusAuth | null) {
  const after = useAfterChange(auth)
  return useMutation({
    mutationFn: (p: { hour: number; enabled: boolean }) =>
      api.digestPrefs(auth!.session, p.hour, tzOffsetMin(), p.enabled),
    onSuccess: after,
  })
}

/** Demo only: asks the chain for one unit above what is left, so the refusal is real. */
export function useDemoOverCap(auth: NuntiusAuth | null) {
  const after = useAfterChange(auth)
  return useMutation({
    mutationFn: (mandateId: string) => api.demoOverCap(auth!.session, mandateId),
    onSuccess: after,
  })
}
