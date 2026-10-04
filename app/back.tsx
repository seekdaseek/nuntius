import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import Clipboard from '@react-native-clipboard/clipboard'
import { Button, Card, KV, Label, Muted, Note, Screen, Segments, Title, color, font } from '@/components/ui'
import { radius } from '@/constants/app-styles'
import { isUserCancellation, useNuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useGrantMandate, useMandateList, type GrantStep } from '@/features/mandates/use-mandates'
import { api, type LaunchInfo } from '@/features/mandates/mandates-api'
import { isBlockhashExpired } from '@/core/grant-errors'
import { grantedSlipUrl } from '@/core/routes'
import { PERIOD_OPTIONS, sanitizeAmount, UNTIL_OPTIONS, type PeriodKey } from '@/core/mandate-form'
import {
  backSentence,
  checkBack,
  demandWords,
  launchesOn,
  quoteSymbolOf,
  routeWords,
  type BackForm,
} from '@/core/back-copy'

/**
 * Back a launch: a capped recurring permission whose every pull buys the launch's token
 * (Meteora Dynamic Bonding Curve, then DAMM v2) and delivers it to the backer's own wallet.
 * One Seed Vault approval; the token account is created in the same transaction.
 */
export default function BackScreen() {
  const auth = useNuntiusAuth()
  const params = useLocalSearchParams<{ pool?: string; amount?: string; period?: string; untilDays?: string }>()
  const [form, setForm] = useState<BackForm>({
    pool: params.pool ?? '',
    amount: params.amount ?? '',
    period: (params.period as PeriodKey) ?? 'week',
    untilDays: Number(params.untilDays ?? 90),
  })
  const [launch, setLaunch] = useState<LaunchInfo | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [, setStep] = useState<GrantStep | null>(null)
  const grant = useGrantMandate(auth, setStep)
  const check = checkBack(form)
  const list = useMandateList(auth)
  const on = launchesOn(list.data)
  const quote = launch ? quoteSymbolOf(launch.quoteMint) : null

  useEffect(() => {
    setLaunch(null)
    setLaunchError(null)
    if (!on || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(form.pool.trim())) return
    let live = true
    api
      .launch(form.pool.trim())
      .then((l) => live && setLaunch(l))
      .catch((e: unknown) => live && setLaunchError(e instanceof Error ? e.message : 'not a launch'))
    return () => {
      live = false
    }
  }, [form.pool, on])

  if (!auth) {
    return (
      <Screen back>
        <Muted>Sign in first.</Muted>
      </Screen>
    )
  }
  // v1.0.1: hidden unless the server turns subscription launches on.
  if (!on) {
    return (
      <Screen back>
        <Muted>Backing a launch is not available in this version.</Muted>
      </Screen>
    )
  }
  const set = <K extends keyof BackForm>(k: K, v: BackForm[K]) => {
    if (grant.isError) grant.reset()
    setForm((f) => ({ ...f, [k]: v }))
  }
  const expired = grant.isError && isBlockhashExpired(grant.error)
  const token = launch?.symbol ?? null
  const ready = check.ok && !!launch && !!quote && launch.route !== 'migrating'

  const footer = (
    <>
      <Muted style={{ marginBottom: 8 }}>
        One approval now. Each period, one transaction takes your amount and buys {token ?? 'the token'} with it,
        straight into your own wallet. If the price moves more than 2% first, that buy is skipped and nothing is taken.
      </Muted>
      <Button
        big
        testID="back-approve"
        title={
          grant.isPending ? 'Waiting for Seed Vault' : expired ? 'Rebuild and approve again' : 'Approve in Seed Vault'
        }
        busy={grant.isPending}
        disabled={!ready}
        onPress={() =>
          grant.mutate(
            {
              terms: {
                label: `Back ${token ?? 'launch'}`.slice(0, 40),
                payee: '',
                amount: form.amount,
                period: form.period,
                untilDays: form.untilDays,
                symbol: quote!,
                pool: form.pool.trim(),
              },
              rebuild: expired,
            },
            {
              onSuccess: ({ mandate }) =>
                router.replace(
                  grantedSlipUrl({
                    label: mandate.label,
                    payee: mandate.payee,
                    delegationPda: mandate.delegationPda,
                    cap: mandate.cap,
                    symbol: mandate.symbol,
                    atMs: Date.now(),
                  }) as never,
                ),
            },
          )
        }
      />
    </>
  )

  return (
    <Screen back footer={footer}>
      <Title style={{ marginTop: 6 }}>Back a launch</Title>
      <Label>Launch pool (Meteora)</Label>
      <View style={s.field}>
        <TextInput
          testID="pool"
          style={s.input}
          value={form.pool}
          placeholder="pool address"
          placeholderTextColor={color.slotPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(v) => set('pool', v.trim())}
        />
        <Button
          title="Paste"
          kind="ghost"
          onPress={() => void Clipboard.getString().then((v) => set('pool', v.trim()))}
        />
      </View>
      {launchError ? <Note tone="refused">Not a launch nuntius can read: {launchError}</Note> : null}
      {launch ? (
        <Card>
          <KV k="Token" v={token ?? launch.baseMint.slice(0, 8)} />
          <KV k="Now" v={routeWords(launch)} />
          <KV k="Committed" v={demandWords(launch.committed)} />
          {!quote ? (
            <Note tone="refused">This launch is priced in a token nuntius does not pull (only USDC or SKR).</Note>
          ) : null}
        </Card>
      ) : null}

      <Text style={s.sentence} testID="back-sentence">
        {backSentence(form, token, quote ?? 'USDC')}
      </Text>
      <Label>Amount each period</Label>
      <TextInput
        testID="back-amount"
        style={s.input}
        value={form.amount}
        placeholder="amount"
        placeholderTextColor={color.slotPlaceholder}
        keyboardType="decimal-pad"
        onChangeText={(v) => set('amount', sanitizeAmount(v))}
      />
      <Label>Every</Label>
      <Segments
        options={PERIOD_OPTIONS}
        value={form.period}
        onChange={(v) => set('period', v)}
        testIDPrefix="back-period"
      />
      <Label>For</Label>
      <Segments
        options={UNTIL_OPTIONS.map((d) => ({ key: d, label: `${d} days` }))}
        value={form.untilDays as (typeof UNTIL_OPTIONS)[number]}
        onChange={(v) => set('untilDays', v)}
        testIDPrefix="back-until"
      />
      {check.hint && form.pool ? <Muted>{check.hint}</Muted> : null}
      {grant.isError && !expired && !isUserCancellation(grant.error) ? (
        <Note tone="refused">{grant.error.message}</Note>
      ) : null}
      <Button title="Launch your own token" kind="outline" onPress={() => router.push('/launch')} testID="to-launch" />
    </Screen>
  )
}

const s = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: font.medium,
    fontSize: 15,
    color: color.ink,
    backgroundColor: color.card,
  },
  sentence: { fontFamily: font.semibold, fontSize: 20, lineHeight: 28, color: color.ink, marginVertical: 12 },
})
