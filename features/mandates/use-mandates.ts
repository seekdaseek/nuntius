import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import type { NuntiusAuth } from '@/features/account/use-nuntius-auth'
import { api, ApiError, untilLanded, type TermsInput } from '@/features/mandates/mandates-api'
import { signAndSend } from '@/features/wallet/sign-and-send'
import { refreshWidget } from '@/features/widget/refresh-widget'
import { tzOffsetMin } from '@/core/format'
import { isUserCancel, WalletStepError } from '@/core/wallet-session'
import { landedAnyway } from '@/core/grant-errors'
import { checkTransaction, expectGrant } from '@/core/tx-check'
import { AppConfig } from '@/constants/app-config'

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
 *
 * The transaction is built inside the wallet session, after authorize, so its
 * blockhash is fresh when the sheet opens. If it still dies in Seed Vault,
 * mutate({ terms, rebuild: true }) asks the server for the same permission with
 * a new blockhash and reopens Seed Vault; if the first copy landed after all,
 * it just confirms.
 */
export function useGrantMandate(auth: NuntiusAuth | null, onStep?: (s: GrantStep) => void) {
  const { chain, identity } = useMobileWallet()
  const after = useAfterChange(auth)
  const pending = useRef<string | null>(null)
  return useMutation({
    mutationFn: async ({
      terms,
      rebuild = false,
      shownAllowance,
      baseMint,
    }: {
      terms: TermsInput
      rebuild?: boolean
      /** The total the screen showed ("Seed Vault will show X"); null for no limit; undefined if not shown. */
      shownAllowance?: string | null
      /** A back permission: the launch token the screen named. */
      baseMint?: string
    }) => {
      if (!auth) throw new Error('not signed in')
      // Built before anything is fetched, from what the user typed and saw.
      const expect = expectGrant({
        wallet: auth.address,
        symbol: terms.symbol ?? 'USDC',
        amount: terms.amount,
        period: terms.period,
        untilDays: terms.untilDays,
        executor: AppConfig.executor,
        shownAllowance,
        nowMs: Date.now(),
        baseMint,
      })
      onStep?.('building')
      let mandateId = rebuild ? pending.current : null
      let signature: string | null = null
      try {
        onStep?.('signing')
        signature = await signAndSend(
          chain,
          identity,
          auth.address,
          async () => {
            if (mandateId) return (await api.rebuild(auth.session, mandateId)).transactionBase64
            const created = await api.create(auth.session, terms)
            mandateId = pending.current = created.mandateId
            return created.transactionBase64
          },
          (base64) => checkTransaction(base64, expect),
        )
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'already_on_chain')) {
          // The wallet may have sent it before reporting an error: ask the chain, through the server.
          const landed = await landedAnyway(
            e,
            mandateId !== null,
            () => api.confirm(auth.session, mandateId!),
            (x) => x instanceof ApiError && x.code === 'not_on_chain_yet',
            { cancelled: isUserCancel(e) },
          )
          if (!landed) throw e
          pending.current = null
          return { signature, mandate: landed.mandate }
        }
      }
      onStep?.('confirming')
      const confirmed = await untilLanded(() => api.confirm(auth.session, mandateId!), ['not_on_chain_yet'])
      pending.current = null
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
    mutationFn: async ({
      delegationPda,
      mint,
      allowance,
    }: {
      delegationPda: string
      /** The permission's mint, from the list. */
      mint: string | null
      /** That token account's allowance now, base units, when the list reports it. */
      allowance?: bigint | null
    }) => {
      if (!auth) throw new Error('not signed in')
      const tx = await api.revoke(auth.session, delegationPda)
      const signature = await signAndSend(chain, identity, auth.address, tx.transactionBase64, (base64) =>
        checkTransaction(base64, { kind: 'revoke', wallet: auth.address, delegationPda, mint, allowance }),
      ).catch((e: unknown) => {
        throw new WalletStepError(e)
      })
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
