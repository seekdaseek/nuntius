import React from 'react'
import { Muted, Screen, Title } from '@/components/ui'
import { useNuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useReceipts } from '@/features/mandates/use-mandates'
import { ReceiptRow } from '@/components/receipt-row'

/** Every receipt, newest first: pulls, chain refusals, grants and revokes, from nuntius or any other app. */
export default function ReceiptsScreen() {
  const auth = useNuntiusAuth()
  const r = useReceipts(auth)
  return (
    <Screen back>
      <Title style={{ marginTop: 6 }}>Receipts</Title>
      <Muted>Each one opens the transaction on the chain, or the change the chain made visible.</Muted>
      {r.isLoading ? <Muted>Loading…</Muted> : null}
      {(r.data?.receipts ?? []).map((x) => (
        <ReceiptRow key={x.id} r={x} cluster={r.data?.cluster} />
      ))}
      {r.data && r.data.receipts.length === 0 ? <Muted>No receipts yet.</Muted> : null}
    </Screen>
  )
}
