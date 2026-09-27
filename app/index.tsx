import React, { useEffect } from 'react'
import { Linking, Pressable, Text, View } from 'react-native'
import { router } from 'expo-router'
import { Body, Button, Card, CapBar, H1, H2, Muted, Pill, Row, Screen, theme } from '@/components/ui'
import { useNuntiusAuth, useSignOut, useVerifySeekerMutation } from '@/features/account/use-nuntius-auth'
import { AccountFeatureSignIn } from '@/features/account/account-feature-sign-in'
import { usePushRegistration } from '@/features/push/use-push-registration'
import { useDemoOverCap, useMandateList, useReceipts, useRevoke } from '@/features/mandates/use-mandates'
import type { MandateView, OtherDelegation } from '@/features/mandates/mandates-api'
import { ReceiptRow } from '@/components/receipt-row'
import { remainingShare, resetsIn, shortAddr } from '@/core/format'
import { refreshWidget } from '@/features/widget/refresh-widget'

/**
 * Home is the permission list: every delegation this wallet has granted, to
 * nuntius or to anyone else, with the cap left and a one-approval revoke.
 */
export default function HomeScreen() {
  const auth = useNuntiusAuth()
  usePushRegistration(auth)
  return <Screen>{auth ? <SignedIn /> : <Welcome />}</Screen>
}

function Welcome() {
  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 6, marginTop: 24 }}>
        <Muted>nuntius · mandatum</Muted>
        <H1>Grant it once. The chain holds the line.</H1>
      </View>
      <Card>
        <Body strong>One approval in Seed Vault</Body>
        <Muted>Let someone take up to a fixed amount each day, week or 30 days. Nothing more, ever.</Muted>
      </Card>
      <Card tone="chain">
        <Body strong>Enforced by Solana, not by us</Body>
        <Muted>
          Anything above your cap is rejected by the Subscriptions program itself. You get a receipt either way.
        </Muted>
      </Card>
      <Card>
        <Body strong>Every permission, one place</Body>
        <Muted>See and revoke what any app can pull from this wallet, with one approval.</Muted>
      </Card>
      <AccountFeatureSignIn />
    </View>
  )
}

function SignedIn() {
  const auth = useNuntiusAuth()!
  const list = useMandateList(auth)
  const receipts = useReceipts(auth)
  const data = list.data

  useEffect(() => {
    if (data) void refreshWidget(auth.session)
  }, [data, auth.session])

  return (
    <View style={{ gap: 14 }}>
      <Row>
        <View style={{ flex: 1 }}>
          <H1>Permissions</H1>
          <Muted>{shortAddr(auth.address)}</Muted>
        </View>
        <Pill label={auth.sgtMint ? 'Seeker verified' : 'Basic'} tone={auth.sgtMint ? 'chain' : 'plain'} />
      </Row>

      {auth.sgtMint ? (
        <Pressable onPress={() => router.push('/digest')}>
          <Card tone="amber">
            <Body strong>Clock in</Body>
            <Muted>Today’s digest: what moved, what was refused, what is left.</Muted>
          </Card>
        </Pressable>
      ) : null}

      {list.isLoading ? <Muted>Reading the chain…</Muted> : null}
      {list.isError ? <Text style={{ color: theme.refused }}>Could not load: {list.error.message}</Text> : null}

      {data ? (
        <>
          <Row>
            <View style={{ flex: 1 }}>
              <H2>Your mandates</H2>
            </View>
            <Button
              title="New mandate"
              kind="secondary"
              onPress={() => router.push({ pathname: '/new', params: { symbol: data.mints[0] ?? 'USDC' } })}
              disabled={data.mine.length >= data.limits.maxActiveMandates}
              testID="new-mandate"
            />
          </Row>
          {data.mine.length === 0 ? (
            <Card>
              <Muted>
                No mandates yet. Create one: a payee, an amount, a period. One approval, and it runs while the phone
                stays in your pocket.
              </Muted>
            </Card>
          ) : (
            data.mine.map((m) => <MandateCard key={m.id} m={m} demo={data.demo} />)
          )}
          {data.mine.length >= data.limits.maxActiveMandates && data.tier === 'basic' ? (
            <Muted>Basic tier holds one mandate. Verify Seeker ownership below to hold up to 10.</Muted>
          ) : null}

          <H2>Other apps with access</H2>
          {data.others.length === 0 ? (
            <Card tone="chain">
              <Body>No other app can pull from this wallet through the Subscriptions program.</Body>
            </Card>
          ) : (
            data.others.map((o) => <OtherCard key={o.delegationPda} o={o} />)
          )}

          <Card>
            <Muted>
              Token account delegate:{' '}
              {data.tokenAccount.delegate
                ? `${shortAddr(data.tokenAccount.delegate)} (Subscription Authority, program-controlled)`
                : 'none'}
            </Muted>
          </Card>
        </>
      ) : null}

      <Row>
        <View style={{ flex: 1 }}>
          <H2>Receipts</H2>
        </View>
        <Button title="All" kind="ghost" onPress={() => router.push('/receipts')} />
      </Row>
      {(receipts.data?.receipts ?? []).slice(0, 3).map((r) => (
        <ReceiptRow key={r.id} r={r} cluster={receipts.data?.cluster} />
      ))}
      {receipts.data && receipts.data.receipts.length === 0 ? (
        <Muted>Nothing yet. Every pull will land here.</Muted>
      ) : null}

      <AccountFooter />
    </View>
  )
}

function MandateCard({ m, demo }: { m: MandateView; demo: boolean }) {
  const auth = useNuntiusAuth()
  const revoke = useRevoke(auth)
  const overCap = useDemoOverCap(auth)
  const now = Date.now()
  return (
    <Card>
      <Row>
        <View style={{ flex: 1 }}>
          <Body strong>{m.label || shortAddr(m.payee)}</Body>
        </View>
        <Pill label="enforced on chain" tone="chain" />
      </Row>
      <Body>{m.text.headline}</Body>
      <CapBar share={remainingShare(m.remaining, m.cap)} />
      <Muted>
        {m.remaining ?? '—'} of {m.cap} {m.symbol} left · {resetsIn(m.nextResetTs, now)}
      </Muted>
      <Muted>{m.text.guarantee}</Muted>
      <Row>
        <Button title="Revoke" kind="danger" busy={revoke.isPending} onPress={() => revoke.mutate(m.delegationPda)} />
        {demo ? (
          <Button
            title="Try to take more"
            kind="secondary"
            busy={overCap.isPending}
            onPress={() => overCap.mutate(m.id)}
            testID="demo-overcap"
          />
        ) : null}
      </Row>
      {overCap.data?.refusedByChain ? (
        <Text style={{ color: theme.refused, fontWeight: '700' }}>Refused by the chain (0x190). Nothing moved.</Text>
      ) : null}
      {revoke.isError ? <Text style={{ color: theme.refused }}>Revoke failed: {revoke.error.message}</Text> : null}
    </Card>
  )
}

function OtherCard({ o }: { o: OtherDelegation }) {
  const auth = useNuntiusAuth()
  const revoke = useRevoke(auth)
  const every = o.periodLengthS ? periodWords(o.periodLengthS) : ''
  return (
    <Card>
      <Row>
        <View style={{ flex: 1 }}>
          <Body strong>{shortAddr(o.delegatee)}</Body>
        </View>
        <Pill label={o.kind} tone="amber" />
      </Row>
      {o.kind === 'recurring' ? (
        <>
          <Body>
            Can pull up to {o.cap} {o.symbol} {every}.
          </Body>
          <CapBar share={remainingShare(o.remaining, o.cap)} />
          <Muted>
            {o.remaining} of {o.cap} {o.symbol} left · {resetsIn(o.nextResetTs, Date.now())}
          </Muted>
        </>
      ) : o.kind === 'fixed' ? (
        <Body>
          Can still pull {o.remaining} {o.symbol} in total.
        </Body>
      ) : (
        <Body>A subscription plan. Cancel it in the merchant’s app.</Body>
      )}
      {o.revocable ? (
        <Button title="Revoke" kind="danger" busy={revoke.isPending} onPress={() => revoke.mutate(o.delegationPda)} />
      ) : null}
      {revoke.isError ? <Text style={{ color: theme.refused }}>Revoke failed: {revoke.error.message}</Text> : null}
    </Card>
  )
}

function periodWords(s: number): string {
  if (s === 86_400) return 'every day'
  if (s === 604_800) return 'every week'
  if (s === 2_592_000) return 'every 30 days'
  if (s === 3_600) return 'every hour'
  return `every ${s} seconds`
}

function AccountFooter() {
  const auth = useNuntiusAuth()!
  const verify = useVerifySeekerMutation()
  const signOut = useSignOut()
  return (
    <View style={{ gap: 8, marginTop: 12 }}>
      {!auth.sgtMint ? (
        <>
          <Button
            title={verify.isPending ? 'Verifying…' : 'Verify Seeker ownership'}
            kind="secondary"
            onPress={() => verify.mutate(auth)}
            busy={verify.isPending}
          />
          {verify.isSuccess && verify.data.sgtMint === null ? (
            <Muted>No Seeker Genesis Token found for this wallet.</Muted>
          ) : null}
        </>
      ) : (
        <Muted>Genesis Token {shortAddr(auth.sgtMint)}</Muted>
      )}
      <Button title="Sign out" kind="ghost" onPress={() => void signOut()} />
      <Pressable onPress={() => void Linking.openURL('https://github.com/seekdaseek/nuntius')}>
        <Muted>Open source · github.com/seekdaseek/nuntius</Muted>
      </Pressable>
    </View>
  )
}
