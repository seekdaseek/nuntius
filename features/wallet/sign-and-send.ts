import { getBase64Encoder, getTransactionDecoder, type Transaction } from '@solana/kit'
import { transact, type useMobileWallet } from '@wallet-ui/react-native-kit'

type MobileWallet = ReturnType<typeof useMobileWallet>

/**
 * Hands ONE server-built transaction to Seed Vault and returns its signature.
 *
 * Authorizes fresh inside every transact session and never replays a stored
 * auth_token — the rule that fixed the MWA cancel bug (66ab4e8). The server
 * built the bytes with the user as fee payer and sole signer; the wallet shows
 * the user exactly what they are approving.
 */
export async function signAndSend(
  chain: MobileWallet['chain'],
  identity: MobileWallet['identity'],
  transactionBase64: string,
): Promise<string> {
  const transaction: Transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64))
  const signatures = await transact(async (wallet) => {
    await wallet.authorize({ chain, identity })
    return wallet.signAndSendTransactions({ transactions: [transaction as never] })
  })
  const first = signatures[0]
  if (!first) throw new Error('wallet returned no signature')
  return bytesToBase58(first)
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Signature bytes -> base58, so the result is an explorer-openable signature. */
export function bytesToBase58(bytes: Uint8Array): string {
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
