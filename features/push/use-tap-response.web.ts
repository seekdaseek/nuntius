import { useState } from 'react'
import type { TapResponse } from '@/core/notification-tap'

/**
 * Web has no pushes. The end-to-end test (e2e/cold-start-tap.mjs) sets
 * globalThis.__nuntiusTap before the bundle runs, so the web build replays a
 * tap exactly as a cold start from the tray delivers it: already there on the
 * first render. This file is never part of the Android bundle.
 */
export function useTapResponse(): TapResponse | null {
  const [tap] = useState(() => (globalThis as { __nuntiusTap?: TapResponse }).__nuntiusTap ?? null)
  return tap
}
