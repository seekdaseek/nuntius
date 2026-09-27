import React from 'react'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppConfig } from '@/constants/app-config'
import { widgetView, type WidgetSnapshot } from '@/core/widget-model'
import { tzOffsetMin } from '@/core/format'
import { loadAuth } from '@/features/account/auth-storage'
import { PermissionsWidget } from '@/features/widget/permissions-widget'

export const WIDGET_NAME = 'Permissions'
const SNAPSHOT_KEY = 'nuntius-widget-snapshot-v1'

/** Fetches the compact snapshot; falls back to the last good one when offline. */
export async function loadSnapshot(session: string | null): Promise<WidgetSnapshot | null> {
  if (session) {
    try {
      const r = await fetch(`${AppConfig.apiBase}/api/widget`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session, tzOffsetMin: tzOffsetMin() }),
      })
      const json = (await r.json()) as Omit<WidgetSnapshot, 'fetchedAt'> & { ok: boolean }
      if (r.ok && json.ok) {
        const snap: WidgetSnapshot = { ...json, fetchedAt: Date.now() }
        await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap))
        return snap
      }
    } catch {
      // fall through to the cached snapshot
    }
  }
  const cached = await AsyncStorage.getItem(SNAPSHOT_KEY).catch(() => null)
  return cached ? (JSON.parse(cached) as WidgetSnapshot) : null
}

export async function renderCurrent() {
  const auth = await loadAuth()
  const snap = await loadSnapshot(auth?.session ?? null)
  return <PermissionsWidget view={widgetView(snap, Boolean(auth), Date.now())} />
}

/** Redraws every placed widget. Android only; a no-op elsewhere. */
export async function refreshWidget(_session?: string): Promise<void> {
  if (Platform.OS !== 'android') return
  try {
    // Required lazily so non-Android bundles never touch the native module.
    const { requestWidgetUpdate } =
      require('react-native-android-widget') as typeof import('react-native-android-widget')
    await requestWidgetUpdate({ widgetName: WIDGET_NAME, renderWidget: () => renderCurrent() })
  } catch (e) {
    console.log(`widget: refresh failed: ${e instanceof Error ? e.message : 'unknown'}`)
  }
}
