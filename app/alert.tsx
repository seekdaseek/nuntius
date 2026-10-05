import React from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { skipWords } from '@/core/back-copy'
import { Button, CapMeter, Chip, KV, Muted, Note, Screen, Slip, Stamp, Title, color, font } from '@/components/ui'
import { tabular } from '@/constants/app-styles'
import { explorerTx, shortAddr, tzOffsetMin } from '@/core/format'
import { slipMeter, whenWords } from '@/core/home-model'

/**
 * The receipt: what every push opens. Never a bare number — what moved, what
 * is left this period, who signed, and the transaction to check it against.
 * Moved is a mint slip; refused is a raspberry slip with the chain's stamp.
 */
export default function ReceiptScreen() {
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
    per?: string
    payee?: string
    got?: string
    why?: string
  }>()

  // Receipt pushes and the older delegation spike share this screen.
  const kind = p.kind ?? (p.source === 'delegation' ? 'pull' : undefined)
  const amount = p.amount || p.moved
  const symbol = p.symbol ?? ''
  const explorer = p.sig ? explorerTx(p.sig, p.cluster) : null
  const at = p.at && /^\d+$/.test(p.at) ? whenWords(Number(p.at), tzOffsetMin()) : null
  const who = p.who ?? 'This permission'
  const byOther = p.actor === 'other'

  const explorerButton = explorer ? (
    <Button title="Open on Solana Explorer" kind="outline" onPress={() => void Linking.openURL(explorer)} />
  ) : p.sig ? (
    <Muted style={{ textAlign: 'center' }}>Local test validator, not on a public explorer.</Muted>
  ) : null

  if (kind === 'pull') {
    // The meter shows what was left right after this pull, as the receipt recorded
    // it (push link or list); a receipt without that record shows none rather than a guess.
    const mt = slipMeter(
      {
        cap: p.cap,
        remaining: p.remaining,
        per: p.per && /^\d+$/.test(p.per) ? Number(p.per) : null,
        reset: p.reset && /^\d+$/.test(p.reset) ? Number(p.reset) : null,
      },
      Date.now(),
    )
    return (
      <Screen back tint="moved">
        <Slip>
          <Chip label="✓ Moved" tone="moved" />
          <Text style={s.amount}>
            {amount} {symbol}
          </Text>
          <Muted style={{ marginBottom: 12 }}>
            {who}
            {at ? `, ${at}` : ''}
          </Muted>
          {mt ? (
            <View style={{ marginBottom: 14 }}>
              <CapMeter takenShare={mt.takenShare} left={mt.left} right={mt.right} />
            </View>
          ) : null}
          <KV k="Signed by" v={byOther ? `${shortAddr(p.who ?? '')}, another app` : 'nuntius executor only'} />
          <KV k="You signed" v="nothing" />
          {p.sig ? <KV k="Transaction" v={shortAddr(p.sig)} /> : null}
          {explorerButton}
        </Slip>
      </Screen>
    )
  }

  if (kind === 'buy') {
    // A back permission's buy: the pull and the swap in one transaction, the tokens in the backer's own account.
    return (
      <Screen back tint="moved">
        <Slip>
          <Chip label="✓ Bought" tone="moved" />
          <Text style={s.amount}>{p.got || `${amount} ${symbol}`}</Text>
          <Muted style={{ marginBottom: 12 }}>
            {p.got ? `for ${amount} ${symbol}, ` : ''}
            {who}
            {at ? `, ${at}` : ''}
          </Muted>
          <KV k="Delivered to" v="your own token account" />
          <KV k="Signed by" v="nuntius executor only" />
          <KV k="You signed" v="nothing" />
          {p.sig ? <KV k="Transaction" v={shortAddr(p.sig)} /> : null}
          {explorerButton}
        </Slip>
      </Screen>
    )
  }

  if (kind === 'migrated') {
    return (
      <Screen back>
        <Slip>
          <Chip label="Migrated" tone="plain" />
          <Text style={s.amount}>{p.got ? `${p.got} moved` : 'The token moved'}</Text>
          <Muted style={{ marginBottom: 12 }}>
            {who}: the curve filled and moved to its regular pool on Meteora (DAMM v2). Your next buys go there, with
            the same cap. You signed nothing.
          </Muted>
          {explorerButton}
        </Slip>
      </Screen>
    )
  }

  if (kind === 'skipped') {
    return (
      <Screen back>
        <Slip>
          <Chip label="Skipped" tone="plain" />
          <Text style={s.amount}>Nothing taken</Text>
          <Muted style={{ marginBottom: 12 }}>
            {who}: {skipWords(p.why)}{' '}
            {!p.why || p.why === 'slippage'
              ? 'The whole transaction failed, and nuntius tries again later this period.'
              : 'The whole transaction failed.'}
          </Muted>
        </Slip>
      </Screen>
    )
  }

  if (kind === 'refused') {
    return (
      <Screen back tint="refused">
        <Slip>
          <Stamp label="Refused by the chain" />
          <Text style={[s.amount, { color: color.refusedInk }]}>Nothing moved</Text>
          <Muted style={{ marginBottom: 12 }}>
            {amount
              ? `${who} asked for ${amount} ${symbol}, more than was left under its cap.`
              : `${who} asked for more than its cap allows.`}
          </Muted>
          <KV k="Program answer" v={'error 0x190\namount exceeds period limit'} />
          {p.cap ? <KV k="Cap this period" v={`${p.cap} ${symbol}, all used`} /> : null}
          {p.sig ? <KV k="Transaction" v={`${shortAddr(p.sig)}, failed`} /> : null}
          {explorerButton}
        </Slip>
      </Screen>
    )
  }

  const titles: Record<string, string> = {
    granted: byOther ? 'New permission on your wallet' : 'Permission live',
    revoked: 'Revoked',
    expired: 'Expired',
  }
  return (
    <Screen back>
      <Title style={{ marginTop: 6 }}>{kind ? (titles[kind] ?? kind) : 'Notification'}</Title>
      {kind ? (
        <Note tone={kind === 'granted' && byOther ? 'foreign' : 'moved'}>
          {kind === 'granted' && byOther
            ? `${who} can now pull ${symbol} from this wallet. It was not created in nuntius. Revoke it from the home screen if you did not mean to grant it.`
            : kind === 'granted'
              ? `${who} is live: at most ${amount ? `${amount} ${symbol}` : 'its cap'} a period, enforced by the chain.${
                  p.source === 'grant'
                    ? ` The first payment${p.payee ? ` to ${shortAddr(p.payee)}` : ''} goes out in a moment, and every pull sends a receipt to this phone.`
                    : ''
                }`
              : `${who} can no longer take anything.`}
        </Note>
      ) : (
        <Muted>
          {p.source ?? 'unknown'}
          {p.at ? `, sent ${p.at}` : ''}
        </Muted>
      )}
      {p.pda ? <KV k="Permission account" v={shortAddr(p.pda)} /> : null}
    </Screen>
  )
}

const s = StyleSheet.create({
  amount: {
    fontFamily: font.display,
    fontSize: 44,
    lineHeight: 48,
    letterSpacing: -1,
    color: color.ink,
    marginTop: 14,
    ...tabular,
  },
})
