import { getBase64Encoder, getTransactionDecoder, type SignatureBytes, type Transaction } from '@solana/kit'
import { transact, type useMobileWallet } from '@wallet-ui/react-native-kit'
import { withStoredAuthorization } from '@/core/wallet-session'
import { loadWalletToken, saveWalletToken } from '@/features/wallet/wallet-auth-storage'

type MobileWallet = ReturnType<typeof useMobileWallet>

/**
 * Hands ONE server-built transaction to Seed Vault and returns its signature.
 *
 * Authorizes with the token from the last authorize for this wallet, so Seed
 * Vault opens straight on the transaction (one sheet, no "Connect" picker).
 * A token the wallet refuses is dropped and the request retried once without
 * one (core/wallet-session.ts), so a stale token never locks the app out, the
 * failure 66ab4e8 fixed. The server built the bytes with the user as fee payer
 * and sole signer; the wallet shows the user exactly what they are approving.
 *
 * The transaction may be given as a function: it is then fetched only after
 * authorize, inside the wallet session, so its blockhash is as fresh as it can
 * be when the sign sheet opens.
 */
export async function signAndSend(
  chain: MobileWallet['chain'],
  identity: MobileWallet['identity'],
  address: string,
  transactionBase64: string | (() => Promise<string>),
): Promise<string> {
  const signatures = await withStoredAuthorization<SignatureBytes[]>({
    load: () => loadWalletToken(address),
    save: (token) => saveWalletToken(address, token),
    run: async (token) =>
      await transact(async (wallet) => {
        const auth = await wallet.authorize({ chain, identity, ...(token ? { auth_token: token } : {}) })
        const account = auth.accounts[0]?.address
        if (account && base64ToBase58(account) !== address) {
          throw new Error(
            `Seed Vault is on another wallet (${short(base64ToBase58(account))}). Sign in again with ${short(address)}.`,
          )
        }
        const base64 = typeof transactionBase64 === 'string' ? transactionBase64 : await transactionBase64()
        const transaction: Transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64))
        const result = await wallet.signAndSendTransactions({ transactions: [transaction as never] })
        return { result, token: auth.auth_token }
      }),
  })
  const first = signatures[0]
  if (!first) throw new Error('wallet returned no signature')
  return bytesToBase58(first)
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const base64ToBase58 = (b64: string) => bytesToBase58(new Uint8Array(getBase64Encoder().encode(b64)))

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
