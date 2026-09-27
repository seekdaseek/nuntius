import './polyfill'
import 'expo-router/entry'
import { Platform } from 'react-native'

// Home-screen widget (Android only). Registered at the entry so Android can
// render it headlessly without the app open.
if (Platform.OS === 'android') {
  const { registerWidgetTaskHandler } = require('react-native-android-widget')
  const { widgetTaskHandler } = require('./features/widget/widget-task-handler')
  registerWidgetTaskHandler(widgetTaskHandler)
}
