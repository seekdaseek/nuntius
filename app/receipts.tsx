import React from 'react'
import { H1, Muted, Screen } from '@/components/ui'
import { useNuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useReceipts } from '@/features/mandates/use-mandates'
import { ReceiptRow } from '@/components/receipt-row'

/** Every receipt, newest first: pulls, chain refusals, grants and revokes, from nuntius or any other app. */
export default function ReceiptsScreen() {
  const auth = useNuntiusAuth()
  const r = useReceipts(auth)
  return (
    <Screen>
      <H1>Receipts</H1>
      <Muted>Each one is a transaction you can open on an explorer, or a change the chain made visible.</Muted>
      {r.isLoading ? <Muted>Loading…</Muted> : null}
      {(r.data?.receipts ?? []).map((x) => (
        <ReceiptRow key={x.id} r={x} cluster={r.data?.cluster} />
      ))}
      {r.data && r.data.receipts.length === 0 ? <Muted>No receipts yet.</Muted> : null}
    </Screen>
  )
}
