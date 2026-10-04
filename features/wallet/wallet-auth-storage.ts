import { readSecret, writeSecret } from '@/features/storage/secure-kv'

/**
 * The auth_token from the last Seed Vault authorize, for the signed-in wallet
 * only. Passing it back lets Seed Vault skip the "Connect" wallet picker. It
 * grants nothing by itself: every transaction still needs its own approval.
 * Cleared on sign-out; dropped when the wallet refuses it (core/wallet-session).
 * Kept in the Android keystore (expo-secure-store), moved there from v1.0.0's
 * AsyncStorage on first read.
 */
const KEY = 'nuntius-wallet-auth-v1'

export async function loadWalletToken(address: string): Promise<string | null> {
  try {
    const raw = await readSecret(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { address?: unknown; token?: unknown }
    return v.address === address && typeof v.token === 'string' ? v.token : null
  } catch {
    return null
  }
}

export async function saveWalletToken(address: string, token: string | null): Promise<void> {
  await writeSecret(KEY, token ? JSON.stringify({ address, token }) : null)
}
