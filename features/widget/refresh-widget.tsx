import React from 'react'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { AppConfig } from '@/constants/app-config'
import { clientHeaders } from '@/core/client-version'
import { widgetView, type WidgetSnapshot } from '@/core/widget-model'
import { tzOffsetMin } from '@/core/format'
import { loadAuth } from '@/features/account/auth-storage'
import { PermissionsWidget } from '@/features/widget/permissions-widget'

export const WIDGET_NAME = 'Permissions'
const SNAPSHOT_KEY = 'nuntius-widget-snapshot-v1'

export interface WidgetData {
  signedIn: boolean
  snap: WidgetSnapshot | null
  /** The fetch failed; snap, if any, is the last good one from storage. */
  error: boolean
}

/**
 * Everything the widget shows, loaded here in the task handler, never inside
 * the widget component: react-native-android-widget calls that component as a
 * plain function outside any React tree, so it must be a pure function of its
 * props. Falls back to the last good snapshot when offline.
 */
export async function loadWidgetData(): Promise<WidgetData> {
  const auth = await loadAuth()
  if (!auth?.session) return { signedIn: false, snap: null, error: false }
  let error = false
  try {
    const r = await fetch(`${AppConfig.apiBase}/api/widget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...clientHeaders },
      body: JSON.stringify({ session: auth.session, tzOffsetMin: tzOffsetMin() }),
    })
    const json = (await r.json()) as Omit<WidgetSnapshot, 'fetchedAt'> & { ok: boolean }
    if (r.ok && json.ok) {
      const snap: WidgetSnapshot = { ...json, fetchedAt: Date.now() }
      await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap)).catch(() => {})
      return { signedIn: true, snap, error: false }
    }
    error = true
  } catch {
    error = true
  }
  const cached = await AsyncStorage.getItem(SNAPSHOT_KEY).catch(() => null)
  return { signedIn: true, snap: cached ? (JSON.parse(cached) as WidgetSnapshot) : null, error }
}

/** The widget element for the current data. Never throws: a failure draws the error state. */
export async function renderCurrent() {
  try {
    const d = await loadWidgetData()
    return <PermissionsWidget view={widgetView(d.snap, d.signedIn, Date.now(), d.error)} />
  } catch {
    return <PermissionsWidget view={widgetView(null, true, Date.now(), true)} />
  }
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
