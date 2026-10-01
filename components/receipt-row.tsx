import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { color, font } from '@/components/ui'
import { radius, tabular } from '@/constants/app-styles'
import type { Receipt } from '@/features/mandates/mandates-api'
import { ago, shortAddr } from '@/core/format'
import { buyLine } from '@/core/back-copy'

const KIND: Record<Receipt['kind'], { title: string; dot: string }> = {
  pull: { title: 'Moved', dot: color.moved },
  refused: { title: 'Refused by the chain', dot: color.refused },
  granted: { title: 'Permission granted', dot: color.signal },
  revoked: { title: 'Revoked', dot: color.ink2 },
  expired: { title: 'Expired', dot: color.ink2 },
  buy: { title: 'Bought', dot: color.moved },
  skipped: { title: 'Skipped', dot: color.ink2 },
}

export function ReceiptRow({ r, cluster }: { r: Receipt; cluster?: string }) {
  const who = r.label ?? shortAddr(r.delegatee)
  const k = KIND[r.kind]
  const foreign = r.actor === 'other'
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
        got: r.got ?? '',
        symbol: r.symbol,
        cap: r.cap ?? '',
        remaining: r.remaining ?? '',
        reset: r.reset ? String(r.reset) : '',
        per: r.per ? String(r.per) : '',
        cluster: cluster ?? '',
        actor: r.actor,
        at: String(r.at),
      },
    })
  return (
    <Pressable onPress={open} accessibilityRole="button">
      <View style={[s.row, r.kind === 'refused' ? s.rowRefused : null]}>
        <View style={[s.dot, { backgroundColor: foreign && r.kind === 'granted' ? color.foreign : k.dot }]} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.title} numberOfLines={1}>
            {k.title}: {who}
          </Text>
          <Text style={s.sub} numberOfLines={1}>
            {[
              buyLine(r) ??
                (r.amount ? `${r.kind === 'refused' ? 'asked for' : ''} ${r.amount} ${r.symbol}`.trim() : null),
              foreign ? 'outside nuntius' : null,
              ago(r.at, Date.now()),
            ]
              .filter(Boolean)
              .join(', ')}
          </Text>
        </View>
      </View>
    </Pressable>
  )
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    backgroundColor: color.card,
    borderRadius: radius.panel,
    padding: 14,
  },
  rowRefused: { backgroundColor: color.refused50 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  title: { fontFamily: font.semibold, fontSize: 15, color: color.ink },
  sub: { fontFamily: font.medium, fontSize: 13, color: color.ink2, ...tabular },
})
