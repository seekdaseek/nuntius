import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { readMigrating, writeSecure, type Kv } from '@/core/secure-migrate'

/**
 * Secrets on the phone (the session token, the wallet's auth_token) live in the
 * Android keystore through expo-secure-store, not in AsyncStorage. Values from
 * v1.0.0's AsyncStorage keys are moved on first read (core/secure-migrate.ts).
 */
const secure: Kv = {
  get: (k) => SecureStore.getItemAsync(k),
  set: (k, v) => SecureStore.setItemAsync(k, v),
  remove: (k) => SecureStore.deleteItemAsync(k),
}
const legacy: Kv = {
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
  remove: (k) => AsyncStorage.removeItem(k),
}

export const readSecret = (key: string) => readMigrating(key, secure, legacy)
export const writeSecret = (key: string, value: string | null) => writeSecure(key, value, secure, legacy)
