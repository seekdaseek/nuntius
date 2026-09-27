import React from 'react'
import { FlexWidget, TextWidget } from 'react-native-android-widget'
import type { WidgetView } from '@/core/widget-model'

/**
 * The home-screen widget. Layout only: every string comes from widgetView()
 * (core/widget-model.ts), which is unit-tested. Tapping opens the screen the
 * view model chose — clock-in when it is due, the permissions list otherwise.
 */
export function PermissionsWidget({ view }: { view: WidgetView }) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: `nuntius://${view.url.replace(/^\//, '')}` }}
      accessibilityLabel={`nuntius. ${view.title}. ${view.footer}`}
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: '#F6F4EE',
        borderRadius: 18,
        padding: 14,
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <FlexWidget style={{ flexDirection: 'row', justifyContent: 'space-between', width: 'match_parent' }}>
        <TextWidget text="nuntius" style={{ fontSize: 13, color: '#5C636B', fontWeight: '700' }} />
        <TextWidget text={view.title} style={{ fontSize: 13, color: '#101418', fontWeight: '700' }} />
      </FlexWidget>
      <FlexWidget style={{ flexDirection: 'column', width: 'match_parent', flexGap: 4 }}>
        {view.rows.map((r, i) => (
          <FlexWidget key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', width: 'match_parent' }}>
            <TextWidget text={r.left} maxLines={1} truncate="END" style={{ fontSize: 14, color: '#101418' }} />
            <TextWidget text={r.right} style={{ fontSize: 14, color: '#127A4E', fontWeight: '700' }} />
          </FlexWidget>
        ))}
      </FlexWidget>
      <TextWidget
        text={view.footer}
        maxLines={1}
        truncate="END"
        style={{ fontSize: 12, color: view.footer.startsWith('Refused') ? '#B3261E' : '#5C636B' }}
      />
    </FlexWidget>
  )
}
