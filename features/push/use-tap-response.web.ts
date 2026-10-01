import { useEffect, useState } from 'react'
import type { TapResponse } from '@/core/notification-tap'

/**
 * Web has no pushes. The end-to-end tests stand in for Android: a tap set as
 * globalThis.__nuntiusTap before the bundle runs arrives exactly as a cold
 * start from the tray delivers it, already there on the first render
 * (e2e/cold-start-tap.test.mjs); a "nuntius-tap" event is a tap while the app
 * is open (e2e/navigation.test.mjs). This file is never part of the Android
 * bundle.
 */
export function useTapResponse(): TapResponse | null {
  const [tap, setTap] = useState(() => (globalThis as { __nuntiusTap?: TapResponse }).__nuntiusTap ?? null)
  useEffect(() => {
    const on = (e: Event) => setTap((e as CustomEvent<TapResponse>).detail)
    window.addEventListener('nuntius-tap', on)
    return () => window.removeEventListener('nuntius-tap', on)
  }, [])
  return tap
}
