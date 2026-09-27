import type { WidgetTaskHandlerProps } from 'react-native-android-widget'
import { renderCurrent, WIDGET_NAME } from '@/features/widget/refresh-widget'

/**
 * Headless entry point Android calls when a widget is placed, resized or due
 * for its periodic update (every 30 minutes, the platform minimum). The app
 * also redraws it after every list refresh and mutation.
 */
export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  if (props.widgetInfo.widgetName !== WIDGET_NAME) return
  switch (props.widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED':
      props.renderWidget(await renderCurrent())
      break
    default:
      break
  }
}
