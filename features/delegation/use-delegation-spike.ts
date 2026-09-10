import { useMutation } from '@tanstack/react-query'
import { getBase64Encoder, getTransactionDecoder, type Transaction } from '@solana/kit'
import { transact, useMobileWallet } from '@wallet-ui/react-native-kit'
import { AppConfig } from '@/constants/app-config'
import type { NuntiusAuth } from '@/features/account/use-nuntius-auth'

/**
 * Devnet delegation spike (BRIEF-05 section 3).
 *
 * The server composes both instructions with the subscriptions SDK and hands the
 * device a base64 transaction; the Seeker only signs. That keeps the SDK — and
 * kit 7 — out of the app bundle, which still resolves kit 6 at the root.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${AppConfig.apiBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await response.json()) as T & { ok: boolean; error?: string }
  if (!response.ok || !json.ok) throw new Error(`${path}: ${json.error ?? `http ${response.status}`}`)
  return json
}

/** base64 wire transaction -> the Transaction object the MWA wrapper expects. */
function decodeTransaction(base64: string): Transaction {
  return getTransactionDecoder().decode(getBase64Encoder().encode(base64))
}

export interface DelegationResult {
  authoritySignature: string
  delegationSignature: string
  delegationPda: string
  mint: string
}

export function useDelegationSpike() {
  const { chain, identity } = useMobileWallet()

  return useMutation({
    mutationFn: async (auth: NuntiusAuth): Promise<DelegationResult> => {
      // 1. Server prepares a devnet mint the wallet holds and builds the
      //    initSubscriptionAuthority transaction.
      const setup = await post<{ transactionBase64: string; mint: string; delegationPda: string }>(
        '/api/delegation/setup',
        { session: auth.session },
      )

      // 2. Seed Vault signs it. Authorize FRESH inside the session and never pass
      //    a stored auth_token — the same rule the sign-in path follows.
      const authoritySignature = await signAndSend(setup.transactionBase64)

      // 3. Only once the authority exists on chain can the delegation pin its
      //    initId, so the second transaction is built after the first lands.
      const create = await post<{ transactionBase64: string; delegationPda: string }>('/api/delegation/create', {
        session: auth.session,
      })
      const delegationSignature = await signAndSend(create.transactionBase64)

      return {
        authoritySignature,
        delegationSignature,
        delegationPda: create.delegationPda,
        mint: setup.mint,
      }
    },
  })

  async function signAndSend(transactionBase64: string): Promise<string> {
    const transaction = decodeTransaction(transactionBase64)
    const signatures = await transact(async (wallet) => {
      await wallet.authorize({ chain, identity })
      return wallet.signAndSendTransactions({ transactions: [transaction as never] })
    })
    const first = signatures[0]
    if (!first) throw new Error('wallet returned no signature')
    return bytesToBase58(first)
  }
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Signature bytes -> base58, so the result is a clickable explorer signature. */
function bytesToBase58(bytes: Uint8Array): string {
  let value = 0n
  for (const b of bytes) value = value * 256n + BigInt(b)
  let out = ''
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out
    value /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}
