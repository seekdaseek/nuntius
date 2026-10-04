/**
 * v1.0.1 moves the session token and the wallet's auth_token from AsyncStorage
 * to the OS keystore (expo-secure-store). An update must not sign anyone out:
 * the first read finds the old value, stores it securely, and only then deletes
 * the old key. If the secure write fails, the old value stays where it was and
 * is still returned, so the next start tries again. Pure: tested with fakes.
 */
export interface Kv {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export async function readMigrating(key: string, secure: Kv, legacy: Kv): Promise<string | null> {
  const now = await secure.get(key)
  if (now !== null) {
    // Moved already; a leftover old copy (a failed delete last time) goes now.
    await legacy.remove(key).catch(() => {})
    return now
  }
  const old = await legacy.get(key)
  if (old === null) return null
  try {
    await secure.set(key, old)
  } catch {
    return old
  }
  await legacy.remove(key).catch(() => {})
  return old
}

/** Writes go to secure storage only; any old copy is removed. null deletes. */
export async function writeSecure(key: string, value: string | null, secure: Kv, legacy: Kv): Promise<void> {
  if (value === null) await secure.remove(key)
  else await secure.set(key, value)
  await legacy.remove(key).catch(() => {})
}
