import { readSecret, writeSecret } from '@/features/storage/secure-kv'

/**
 * The session survives an app restart and is readable by the home-screen
 * widget's headless task. What it can do is bounded: list and read, and build
 * UNSIGNED transactions — every one of which still needs Seed Vault to sign.
 * It cannot move money. Cleared on sign-out. Kept in the Android keystore
 * (expo-secure-store); v1.0.0's AsyncStorage copy is moved on first read.
 */
export interface StoredAuth {
  address: string
  session: string
  sgtMint: string | null
}

const KEY = 'nuntius-auth-v1'

export async function loadAuth(): Promise<StoredAuth | null> {
  try {
    const raw = await readSecret(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<StoredAuth>
    if (typeof v.address !== 'string' || typeof v.session !== 'string') return null
    return { address: v.address, session: v.session, sgtMint: typeof v.sgtMint === 'string' ? v.sgtMint : null }
  } catch {
    return null
  }
}

export async function saveAuth(a: StoredAuth | null): Promise<void> {
  await writeSecret(KEY, a ? JSON.stringify(a) : null)
}
