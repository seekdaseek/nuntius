// react-native-android-widget calls these components as plain functions, outside
// any React tree. The React Compiler (app.json experiments.reactCompiler) would
// add a memo-cache hook to them, which fails there ("Invalid Hook Call") and
// leaves the widget blank. This file opts out; keep it a pure function of props.
'use no memo'

import React from 'react'
import { FlexWidget, TextWidget } from 'react-native-android-widget'
import { color as C, radius } from '@/constants/app-styles'
import type { WidgetView } from '@/core/widget-model'

/**
 * The home-screen widget. Layout only: every string and share comes from
 * widgetView() (core/widget-model.ts), which is unit-tested. Widgets use the
 * system bold (no custom fonts); colours and radii are the app's tokens.
 */

function Meter({ share }: { share: number }) {
  const filled = Math.round(Math.min(1, Math.max(0, share)) * 100)
  return (
    <FlexWidget style={{ flexDirection: 'row', alignItems: 'center', width: 'match_parent', height: 26 }}>
      <FlexWidget
        style={{ flex: 1, height: 12, borderRadius: radius.meter, backgroundColor: C.track, flexDirection: 'row' }}
      >
        {filled > 0 ? (
          <FlexWidget style={{ flex: filled, height: 12, borderRadius: radius.meter, backgroundColor: C.moved }} />
        ) : null}
        {filled < 100 ? <FlexWidget style={{ flex: 100 - filled, height: 12 }} /> : null}
      </FlexWidget>
      {/* The hard stop at the cap. */}
      <FlexWidget style={{ width: 5, height: 22, borderRadius: radius.stop, backgroundColor: C.ink, marginLeft: 3 }} />
    </FlexWidget>
  )
}

export function PermissionsWidget({ view }: { view: WidgetView }) {
  return (
    <FlexWidget
      clickAction="OPEN_URI"
      clickActionData={{ uri: `nuntius://${view.url.replace(/^\//, '')}` }}
      accessibilityLabel={`nuntius. ${view.badge} ${view.footer}`}
      style={{
        height: 'match_parent',
        width: 'match_parent',
        backgroundColor: C.card,
        borderRadius: radius.widget,
        paddingHorizontal: 18,
        paddingVertical: 16,
        flexDirection: 'column',
        flexGap: 10,
      }}
    >
      <FlexWidget style={{ flexDirection: 'row', justifyContent: 'space-between', width: 'match_parent' }}>
        <TextWidget text={view.title} style={{ fontSize: 17, color: C.ink, fontWeight: 'bold' }} />
        <TextWidget text={view.badge} style={{ fontSize: 13, color: C.signal, fontWeight: '600' }} />
      </FlexWidget>
      {view.rows.map((r, i) => (
        <FlexWidget key={i} style={{ flexDirection: 'column', width: 'match_parent' }}>
          <FlexWidget style={{ flexDirection: 'row', justifyContent: 'space-between', width: 'match_parent' }}>
            <TextWidget
              text={r.left}
              maxLines={1}
              truncate="END"
              style={{ fontSize: 13.5, color: C.ink, fontWeight: '600' }}
            />
            <TextWidget text={r.right} style={{ fontSize: 13.5, color: C.ink2 }} />
          </FlexWidget>
          <Meter share={r.takenShare} />
        </FlexWidget>
      ))}
      {view.footer ? (
        <TextWidget
          text={view.footer}
          maxLines={1}
          truncate="END"
          style={{ fontSize: 12.5, color: view.footerTone === 'refused' ? C.refused : C.ink2 }}
        />
      ) : null}
    </FlexWidget>
  )
}
