import React from 'react'
import { Pressable, View } from 'react-native'
import { router } from 'expo-router'
import { Body, Card, Mono, Muted, Row } from '@/components/ui'
import type { Receipt } from '@/features/mandates/mandates-api'
import { ago, shortAddr } from '@/core/format'

const KIND_TITLE: Record<Receipt['kind'], string> = {
  pull: 'Received',
  refused: 'Refused by the chain',
  granted: 'Permission granted',
  revoked: 'Revoked',
  expired: 'Expired',
}

export function ReceiptRow({ r, cluster }: { r: Receipt; cluster?: string }) {
  const who = r.label ?? shortAddr(r.delegatee)
  const open = () =>
    router.push({
      pathname: '/alert',
      params: {
        source: 'receipt',
        kind: r.kind,
        who,
        pda: r.delegationPda,
        sig: r.signature ?? '',
        amount: r.amount ?? '',
        symbol: r.symbol,
        cluster: cluster ?? '',
        actor: r.actor,
      },
    })
  return (
    <Pressable onPress={open}>
      <Card tone={r.kind === 'refused' ? 'refused' : 'plain'}>
        <Row>
          <View style={{ flex: 1 }}>
            <Body strong>
              {KIND_TITLE[r.kind]}: {who}
            </Body>
          </View>
          <Muted>{ago(r.at, Date.now())}</Muted>
        </Row>
        {r.amount ? (
          <Muted>
            {r.kind === 'refused' ? 'asked for' : 'moved'} {r.amount} {r.symbol}
            {r.actor === 'other' ? ' · outside nuntius' : ''}
          </Muted>
        ) : null}
        {r.signature ? <Mono>{shortAddr(r.signature)}</Mono> : null}
      </Card>
    </Pressable>
  )
}
