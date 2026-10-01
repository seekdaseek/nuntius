import { useLayoutEffect, useRef, useState } from 'react'
import type { TapDelivery, TapResponse } from '@/core/notification-tap'

/**
 * Web has no pushes. The end-to-end tests stand in for Android: a tap set as
 * globalThis.__nuntiusTap before the bundle runs arrives exactly as a cold
 * start from the tray delivers it, already there on the first render
 * (e2e/cold-start-tap.test.mjs); a "nuntius-tap" event is a tap while the app
 * is open (e2e/navigation.test.mjs). This file is never part of the Android
 * bundle.
 */
export function useTapDeliveries(): { queue: { current: TapDelivery[] }; tick: number } {
  const queue = useRef<TapDelivery[]>([])
  const [tick, setTick] = useState(0)
  useLayoutEffect(() => {
    const deliver = (source: TapDelivery['source'], response: TapResponse) => {
      queue.current.push({ source, response })
      setTick((t) => t + 1)
    }
    const cold = (globalThis as { __nuntiusTap?: TapResponse }).__nuntiusTap
    if (cold) deliver('launch', cold)
    const on = (e: Event) => deliver('listener', (e as CustomEvent<TapResponse>).detail)
    window.addEventListener('nuntius-tap', on)
    return () => window.removeEventListener('nuntius-tap', on)
  }, [])
  return { queue, tick }
}
