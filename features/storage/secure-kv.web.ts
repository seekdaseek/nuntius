import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * The web build (previews and the e2e tests only) has no keystore:
 * expo-secure-store does not run on web, so it keeps AsyncStorage (localStorage).
 * The Android app uses secure-kv.ts.
 */
export const readSecret = (key: string) => AsyncStorage.getItem(key)
export const writeSecret = async (key: string, value: string | null) => {
  if (value === null) await AsyncStorage.removeItem(key)
  else await AsyncStorage.setItem(key, value)
}
