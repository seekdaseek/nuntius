import * as Notifications from 'expo-notifications'

/** The last notification tap (Android: from the tray, a heads-up, or the cold-start intent). */
export function useTapResponse() {
  return Notifications.useLastNotificationResponse()
}
