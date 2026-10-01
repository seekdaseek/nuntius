import React from 'react'
import { Muted, Screen, Section, Title } from '@/components/ui'
import { useNuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useReceipts } from '@/features/mandates/use-mandates'
import { ReceiptRow } from '@/components/receipt-row'
import { endedHeader } from '@/core/home-model'
import { tzOffsetMin } from '@/core/format'

/**
 * Receipts, newest first: pulls, chain refusals, grants and revokes, from
 * nuntius or any other app. Live permissions first, each since its grant; then
 * every permission that has ended, under its own name and dates, so a new
 * permission never shows an old one's history.
 */
export default function ReceiptsScreen() {
  const auth = useNuntiusAuth()
  const r = useReceipts(auth)
  const ended = r.data?.ended ?? []
  return (
    <Screen back>
      <Title style={{ marginTop: 6 }}>Receipts</Title>
      <Muted>Each one opens the transaction on the chain, or the change the chain made visible.</Muted>
      {r.isLoading ? <Muted>Loading…</Muted> : null}
      {(r.data?.receipts ?? []).map((x) => (
        <ReceiptRow key={x.id} r={x} cluster={r.data?.cluster} />
      ))}
      {r.data && r.data.receipts.length === 0 ? <Muted>Nothing from a live permission yet.</Muted> : null}
      {ended.length > 0 ? <Section>Ended permissions</Section> : null}
      {ended.map((s) => (
        <React.Fragment key={s.key}>
          <Muted style={{ marginTop: 6 }}>{endedHeader(s.label, s.from, s.to, tzOffsetMin())}</Muted>
          {s.receipts.map((x) => (
            <ReceiptRow key={x.id} r={x} cluster={r.data?.cluster} />
          ))}
        </React.Fragment>
      ))}
    </Screen>
  )
}
