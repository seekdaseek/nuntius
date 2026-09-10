/**
 * BRIEF-05 section 4 proof: a delegated pull executes and the phone lights up.
 *
 * The delegation here is authorized by a SERVER keypair, not Seed Vault — the
 * device path is blocked on the wallet's own network setting (see the report).
 * Everything downstream of the authorization is the real path: a real pull on
 * devnet by a delegatee the user never signs for, on-chain state read back, and
 * a real FCM push whose data.url points at the evidence screen.
 *
 *   node --env-file=.env dist/spike-pull-push.js <push-recipient-wallet>
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createKeyPairSignerFromBytes, type TransactionSigner } from '@solana/kit'
import { loadConfig } from './config.js'
import { openDb, Store } from './db.js'
import { FcmSender } from './fcm.js'
import {
  authorizeDelegationServerSide,
  devnetRpcUrl,
  ensureReceiverAta,
  executePull,
  readDelegation,
} from './delegation.js'

const DECIMALS = 6
const UNIT = 10n ** BigInt(DECIMALS)
const CAP = 100n * UNIT
const PERIOD_S = 60n

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

async function loadSigner(file: string): Promise<TransactionSigner> {
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(file, 'utf8')) as number[]))
}

async function main(): Promise<void> {
  const recipient = process.argv[2]
  if (!recipient) fail('usage: node dist/spike-pull-push.js <push-recipient-wallet>')

  const config = loadConfig()
  if (!config.fcmServiceAccount || !config.fcmProjectId) fail('FCM not configured')
  const rpcUrl = devnetRpcUrl(config.heliusRpc)
  const fcm = new FcmSender(config.fcmServiceAccount, config.fcmProjectId)
  const store = new Store(openDb(path.join(import.meta.dirname, '..', 'nuntius.db')))

  const payer = await loadSigner(process.env.SPIKE_PAYER ?? `${process.env.HOME}/.config/solana/id.json`)
  const delegatee = await loadSigner(path.join(import.meta.dirname, '..', 'delegatee.json'))
  console.log(`payer/delegator ${payer.address}`)
  console.log(`delegatee       ${delegatee.address}`)

  const authorized = await authorizeDelegationServerSide({
    rpcUrl,
    owner: payer,
    delegatee: delegatee.address,
    amountPerPeriod: CAP,
    periodLengthS: PERIOD_S,
    decimals: DECIMALS,
  })
  console.log(`mint            ${authorized.mint}`)
  console.log(`authority tx    ${authorized.authoritySignature}`)
  console.log(`delegation tx   ${authorized.delegationSignature}`)
  console.log(`delegation PDA  ${authorized.delegationPda}`)

  // The pull: only the delegatee signs. The delegator is not involved.
  const receiverAta = await ensureReceiverAta({ rpcUrl, payer, mint: authorized.mint, owner: delegatee.address })
  const amount = CAP / 2n
  const signature = await executePull({
    rpcUrl,
    delegatee,
    delegationPda: authorized.delegationPda,
    delegator: payer.address,
    delegatorAta: authorized.userAta,
    receiverAta,
    mint: authorized.mint,
    amount,
  })
  console.log(`PULL EXECUTED   ${signature}`)

  // Evidence comes off the chain, never from what we believe we sent.
  const state = await readDelegation(rpcUrl, authorized.delegationPda)
  const remaining =
    state.amountPerPeriod && state.amountPulledInPeriod
      ? BigInt(state.amountPerPeriod) - BigInt(state.amountPulledInPeriod)
      : 0n
  const nextReset = (state.currentPeriodStartTs ?? 0) + (state.periodLengthS ?? 0)
  console.log(
    `on-chain        pulled ${state.amountPulledInPeriod} of ${state.amountPerPeriod}, resets at ${nextReset}`,
  )

  const url =
    `/alert?source=delegation&sig=${signature}&moved=${amount / UNIT}` +
    `&remaining=${remaining / UNIT}&reset=${nextReset}&pda=${authorized.delegationPda}`
  const tokens = store.getPushTokens(recipient)
  if (tokens.length === 0) fail(`no push tokens registered for ${recipient}`)
  for (const token of tokens) {
    const res = await fcm.send(
      token,
      {
        title: 'Delegated transfer executed',
        body: `${amount / UNIT} tokens moved. ${remaining / UNIT} left this period.`,
      },
      'alerts',
      { url, channelId: 'alerts' },
    )
    console.log(`push -> ${token.slice(0, 12)}… HTTP ${res.status} ${res.body.trim().replace(/\s+/g, ' ')}`)
  }
  console.log(`evidence url    ${url}`)
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)))
