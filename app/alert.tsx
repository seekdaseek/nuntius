import React from 'react'
import { Linking, Text } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { Body, Card, H1, Mono, Muted, Screen, theme } from '@/components/ui'
import { explorerTx, resetsIn } from '@/core/format'

const TITLES: Record<string, string> = {
  pull: 'Received',
  refused: 'Refused by the chain',
  granted: 'Permission granted',
  revoked: 'Revoked',
  expired: 'Expired',
}

/**
 * Evidence screen — what every receipt push opens.
 *
 * Never a bare number: what moved, what is left this period, when the cap
 * resets, and a link out so the claim can be checked independently.
 */
export default function AlertScreen() {
  const p = useLocalSearchParams<{
    source?: string
    kind?: string
    who?: string
    sig?: string
    amount?: string
    symbol?: string
    remaining?: string
    cap?: string
    reset?: string
    pda?: string
    cluster?: string
    actor?: string
    at?: string
    moved?: string
  }>()

  // Receipt pushes (mandatum) and the older delegation spike share this screen.
  const kind = p.kind ?? (p.source === 'delegation' ? 'pull' : undefined)
  const amount = p.amount || p.moved
  const explorer = p.sig ? explorerTx(p.sig, p.cluster) : null

  if (!kind) {
    return (
      <Screen>
        <H1>Notification</H1>
        <Card>
          <Muted>Source: {p.source ?? 'unknown'}</Muted>
          <Muted>Sent at: {p.at ?? 'unknown'}</Muted>
        </Card>
      </Screen>
    )
  }

  const refused = kind === 'refused'
  return (
    <Screen>
      <H1>{TITLES[kind] ?? kind}</H1>
      <Card tone={refused ? 'refused' : kind === 'pull' ? 'chain' : 'plain'}>
        <Body strong>{p.who ?? 'Delegation'}</Body>
        {refused ? (
          <Body>
            A pull above your cap was rejected by the Solana Subscriptions program (custom error 0x190,
            AmountExceedsPeriodLimit). Nothing moved.
          </Body>
        ) : null}
        {refused && amount ? (
          <Muted>
            It asked for {amount} {p.symbol ?? ''}. Even one base unit above what is left is refused.
          </Muted>
        ) : null}
        {kind === 'pull' && amount ? (
          <Text style={{ fontSize: 34, fontWeight: '800', color: theme.ink }}>
            {amount} {p.symbol ?? ''}
          </Text>
        ) : null}
        {p.remaining && p.cap ? (
          <Muted>
            {p.remaining} of {p.cap} {p.symbol ?? ''} left this period
            {p.reset ? ` · ${resetsIn(Number(p.reset), Date.now())}` : ''}
          </Muted>
        ) : null}
        {p.actor === 'other' ? <Muted>This delegation was not created in nuntius.</Muted> : null}
      </Card>
      {p.pda ? (
        <Card>
          <Muted>Delegation account</Muted>
          <Mono>{p.pda}</Mono>
        </Card>
      ) : null}
      {p.sig ? (
        <Card>
          <Muted>Transaction</Muted>
          <Mono>{p.sig}</Mono>
          {explorer ? (
            <Text
              style={{ color: '#1a73e8', textDecorationLine: 'underline' }}
              onPress={() => void Linking.openURL(explorer)}
            >
              Verify on Solana Explorer
            </Text>
          ) : (
            <Muted>Local test validator — not on a public explorer.</Muted>
          )}
        </Card>
      ) : null}
    </Screen>
  )
}
