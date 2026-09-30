import React, { useEffect, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import {
  Body,
  Button,
  CapMeter,
  Card,
  Chip,
  color,
  font,
  Footer,
  Hero,
  Muted,
  Note,
  Row,
  Section,
  StatusBarScrim,
  Wordmark,
} from '@/components/ui'
import { radius, space, tabular } from '@/constants/app-styles'
import { useNuntiusAuth, useSignOut, useVerifySeekerMutation } from '@/features/account/use-nuntius-auth'
import { AccountFeatureSignIn } from '@/features/account/account-feature-sign-in'
import { usePushRegistration } from '@/features/push/use-push-registration'
import { useDemoOverCap, useMandateList, useReceipts, useRevoke } from '@/features/mandates/use-mandates'
import { ApiError, type MandateView, type OtherDelegation } from '@/features/mandates/mandates-api'
import { shortAddr } from '@/core/format'
import { delegateLine } from '@/core/allowance-copy'
import { initial, meter, nextMovement, perWords, span, summaryLine, windowWords } from '@/core/home-model'
import { ReceiptRow } from '@/components/receipt-row'
import { refreshWidget } from '@/features/widget/refresh-widget'

/**
 * Home is the permission list: every delegation this wallet has granted, to
 * nuntius or to anyone else, with the cap meter and a one-approval revoke.
 */
export default function HomeScreen() {
  const auth = useNuntiusAuth()
  usePushRegistration(auth)
  return <View style={s.root}>{auth ? <SignedIn /> : <Welcome />}</View>
}

function Welcome() {
  const [scrolled, setScrolled] = useState(false)
  return (
    <>
      <ScrollView
        contentContainerStyle={s.scroll}
        scrollEventThrottle={32}
        onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 4)}
      >
        <Hero>
          <Wordmark light />
          <Text style={s.heroSentence}>Grant a payment once. The chain holds the line.</Text>
          <Text style={s.heroSub}>Recurring payments you approve once in Seed Vault, capped by Solana itself.</Text>
        </Hero>
        <View style={s.body}>
          <Card>
            <Body style={s.cardTitle}>One approval</Body>
            <Muted>Let someone take up to a fixed amount each day, week or 30 days. Nothing more, ever.</Muted>
          </Card>
          <Card>
            <Body style={s.cardTitle}>Refused by the chain, not by us</Body>
            <Muted>Anything above your cap fails in the Subscriptions program. You get a receipt either way.</Muted>
          </Card>
          <Card>
            <Body style={s.cardTitle}>Every permission in one place</Body>
            <Muted>See what any app can pull from this wallet, and end it with one approval.</Muted>
          </Card>
          <AccountFeatureSignIn />
        </View>
      </ScrollView>
      <StatusBarScrim visible={scrolled} />
    </>
  )
}

function SignedIn() {
  const auth = useNuntiusAuth()!
  const list = useMandateList(auth)
  const receipts = useReceipts(auth)
  const signOut = useSignOut()
  const data = list.data
  const now = Date.now()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    if (data) void refreshWidget(auth.session)
  }, [data, auth.session])
  // Sessions expire after 30 days server-side; an expired one goes back to sign-in.
  const expired = list.error instanceof ApiError && list.error.code === 'session_invalid'
  useEffect(() => {
    if (expired) void signOut()
  }, [expired, signOut])

  const refusedToday = (receipts.data?.receipts ?? []).filter(
    (r) => r.kind === 'refused' && now - r.at < 24 * 3600_000,
  ).length
  const live = (data?.mine ?? []).map((m) => ({
    label: m.label || shortAddr(m.payee),
    cap: m.cap,
    remaining: m.remaining,
    symbol: m.symbol,
    decimals: m.decimals,
    nextResetTs: m.nextResetTs,
  }))
  const atLimit = data ? data.mine.length >= data.limits.maxActiveMandates : false

  return (
    <>
      <ScrollView
        contentContainerStyle={s.scroll}
        scrollEventThrottle={32}
        onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 4)}
      >
        <Hero>
          <Row style={{ justifyContent: 'space-between' }}>
            <Wordmark light />
            {auth.sgtMint ? <Chip label="✓ Seeker verified" tone="glass" /> : null}
          </Row>
          <Text style={s.heroSentence} testID="hero-sentence">
            {data ? nextMovement(live, now) : 'Reading the chain…'}
          </Text>
          {data ? (
            <Text style={s.heroSub}>{summaryLine(data.mine.length, refusedToday, data.others.length)}</Text>
          ) : null}
        </Hero>

        <View style={s.body}>
          {list.isError && !expired ? <Note tone="refused">Could not load: {list.error.message}</Note> : null}

          {auth.sgtMint ? (
            <Pressable onPress={() => router.push('/digest')} accessibilityRole="button">
              <View style={s.clockIn}>
                <Text style={s.clockInText}>Clock in</Text>
                <Text style={s.clockInSub}>What moved, what was refused, what is left</Text>
              </View>
            </Pressable>
          ) : null}

          {data ? (
            <>
              <Section>Your permissions</Section>
              {data.mine.length === 0 ? (
                <Card>
                  <Muted>
                    None yet. A payee, an amount, a period: one approval, and it runs while the phone stays in your
                    pocket.
                  </Muted>
                </Card>
              ) : (
                data.mine.map((m) => <PermissionCard key={m.id} m={m} demo={data.demo} now={now} />)
              )}
              {atLimit && data.tier === 'basic' ? (
                <Muted>Basic tier holds one permission. Verify Seeker ownership below to hold up to 10.</Muted>
              ) : null}

              <Section>Other apps with access</Section>
              {data.others.length === 0 ? (
                <Note tone="moved">No other app can pull from this wallet.</Note>
              ) : (
                data.others.map((o) => <OtherCard key={o.delegationPda} o={o} now={now} />)
              )}
              <Muted style={{ fontSize: 13 }}>
                {delegateLine(
                  data.tokenAccounts ?? [{ symbol: data.mints[0] ?? '', delegate: data.tokenAccount.delegate }],
                  shortAddr,
                )}
              </Muted>
            </>
          ) : null}

          <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <Section style={{ marginTop: 0 }}>Receipts</Section>
            <Pressable onPress={() => router.push('/receipts')} hitSlop={10}>
              <Text style={s.link}>See all</Text>
            </Pressable>
          </Row>
          {(receipts.data?.receipts ?? []).slice(0, 3).map((r) => (
            <ReceiptRow key={r.id} r={r} cluster={receipts.data?.cluster} />
          ))}
          {receipts.data && receipts.data.receipts.length === 0 ? (
            <Muted>Nothing yet. Every pull will land here.</Muted>
          ) : null}

          <AccountFooter />
        </View>
      </ScrollView>
      <StatusBarScrim visible={scrolled} />
      <Footer>
        <Button
          big
          kind="ink"
          title="New permission"
          testID="new-mandate"
          disabled={!data || atLimit}
          onPress={() => router.push({ pathname: '/new', params: { mints: (data?.mints ?? ['USDC']).join(',') } })}
        />
      </Footer>
    </>
  )
}

function Tile({ label, tone }: { label: string; tone: 'signal' | 'foreign' }) {
  return (
    <View style={[s.tile, { backgroundColor: tone === 'signal' ? color.signal50 : color.foreign50 }]}>
      <Text style={[s.tileText, { color: tone === 'signal' ? color.signal : color.foreignInk }]}>{initial(label)}</Text>
    </View>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (ts: number) => {
  const d = new Date(ts * 1000)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}
const everyWords = (p: number) =>
  p === 86_400 ? 'every day' : p === 3_600 ? 'every hour' : p === 604_800 ? 'every week' : 'every 30 days'

function PermissionCard({ m, demo, now }: { m: MandateView; demo: boolean; now: number }) {
  const auth = useNuntiusAuth()
  const revoke = useRevoke(auth)
  const overCap = useDemoOverCap(auth)
  const name = m.label || shortAddr(m.payee)
  const mt = meter(m.cap, m.remaining, m.decimals)
  return (
    <Card>
      <Row>
        <Tile label={name} tone="signal" />
        <Text style={s.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={s.rate}>
          {m.cap} {m.symbol} {perWords(m.periodLengthS)}
        </Text>
      </Row>
      <Muted>
        {name} can take up to {m.cap} {m.symbol} {everyWords(m.periodLengthS)} until {shortDate(m.expiryTs)}. Anything
        more is refused by the chain.
      </Muted>
      <CapMeter
        takenShare={mt.takenShare}
        left={`${mt.taken} taken ${windowWords(m.periodLengthS)}`}
        right={`${mt.left} left${m.nextResetTs ? `, resets in ${span(m.nextResetTs, now)}` : ''}`}
      />
      <Row gap={8} style={{ marginTop: 4 }}>
        <Button title="Revoke" kind="revoke" busy={revoke.isPending} onPress={() => revoke.mutate(m.delegationPda)} />
        {demo ? (
          <Button
            title="Try to take more"
            kind="ghost"
            busy={overCap.isPending}
            onPress={() => overCap.mutate(m.id)}
            testID="demo-overcap"
          />
        ) : null}
      </Row>
      {overCap.data?.refusedByChain ? (
        <Note tone="refused">Refused by the chain, error 0x190. Nothing moved.</Note>
      ) : null}
      {overCap.isError ? <Note tone="refused">{overCap.error.message}</Note> : null}
      {revoke.isError ? <Note tone="refused">Revoke failed: {revoke.error.message}</Note> : null}
    </Card>
  )
}

function OtherCard({ o, now }: { o: OtherDelegation; now: number }) {
  const auth = useNuntiusAuth()
  const revoke = useRevoke(auth)
  const name = shortAddr(o.delegatee)
  const mt = meter(o.cap, o.remaining, o.decimals)
  return (
    <Card style={{ borderWidth: 1.5, borderColor: color.foreign50 }}>
      <Row>
        <Tile label={name} tone="foreign" />
        <Text style={s.name} numberOfLines={1}>
          {name}
        </Text>
        {o.kind === 'recurring' ? (
          <Text style={s.rate}>
            {o.cap} {o.symbol} {perWords(o.periodLengthS)}
          </Text>
        ) : (
          <Chip label={o.kind} tone="foreign" />
        )}
      </Row>
      {o.kind === 'recurring' ? (
        <>
          <Muted>
            Another app can take up to {o.cap} {o.symbol} from this wallet, outside nuntius.
          </Muted>
          <CapMeter
            takenShare={mt.takenShare}
            left={`${mt.taken} taken ${windowWords(o.periodLengthS)}`}
            right={`${mt.left} left${o.nextResetTs ? `, resets in ${span(o.nextResetTs, now)}` : ''}`}
          />
        </>
      ) : o.kind === 'fixed' ? (
        <Muted>
          It can still take {o.remaining} {o.symbol} in total.
        </Muted>
      ) : (
        <Muted>A subscription plan. Cancel it in the merchant’s app.</Muted>
      )}
      {o.revocable ? (
        <Row>
          <Button title="Revoke" kind="revoke" busy={revoke.isPending} onPress={() => revoke.mutate(o.delegationPda)} />
        </Row>
      ) : null}
      {revoke.isError ? <Note tone="refused">Revoke failed: {revoke.error.message}</Note> : null}
    </Card>
  )
}

function AccountFooter() {
  const auth = useNuntiusAuth()!
  const verify = useVerifySeekerMutation()
  const signOut = useSignOut()
  return (
    <View style={{ gap: 10, marginTop: 18 }}>
      <Muted style={{ fontSize: 13 }}>Signed in as {shortAddr(auth.address)}</Muted>
      {!auth.sgtMint ? (
        <>
          <Button
            title={verify.isPending ? 'Verifying…' : 'Verify Seeker ownership'}
            kind="outline"
            onPress={() => verify.mutate(auth)}
            busy={verify.isPending}
          />
          {verify.isSuccess && verify.data.sgtMint === null ? (
            <Muted>No Seeker Genesis Token found for this wallet.</Muted>
          ) : null}
        </>
      ) : (
        <Muted style={{ fontSize: 13 }}>Genesis Token {shortAddr(auth.sgtMint)}</Muted>
      )}
      <Row gap={16}>
        <Pressable onPress={() => void signOut()} hitSlop={8}>
          <Text style={s.link}>Sign out</Text>
        </Pressable>
        <Pressable onPress={() => void Linking.openURL('https://github.com/seekdaseek/nuntius')} hitSlop={8}>
          <Text style={s.link}>Source code</Text>
        </Pressable>
      </Row>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  scroll: { paddingBottom: 40 },
  body: { paddingHorizontal: space.side, paddingTop: 8, gap: space.cardGap },
  heroSentence: {
    fontFamily: font.display,
    fontSize: 31,
    lineHeight: 35,
    letterSpacing: -0.6,
    color: color.white,
    marginTop: 18,
  },
  heroSub: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: color.onSignalMuted },
  cardTitle: { fontFamily: font.semibold, fontSize: 17 },
  clockIn: {
    backgroundColor: color.signal50,
    borderRadius: radius.card,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 2,
    marginTop: 8,
  },
  clockInText: { fontFamily: font.bold, fontSize: 16, color: color.signal },
  clockInSub: { fontFamily: font.medium, fontSize: 13, color: color.ink2 },
  tile: { width: 36, height: 36, borderRadius: radius.tile, alignItems: 'center', justifyContent: 'center' },
  tileText: { fontFamily: font.display, fontSize: 17 },
  name: { fontFamily: font.semibold, fontSize: 17, color: color.ink, flex: 1 },
  rate: { fontFamily: font.semibold, fontSize: 15, color: color.ink, ...tabular },
  link: { fontFamily: font.semibold, fontSize: 14, color: color.signal },
})
