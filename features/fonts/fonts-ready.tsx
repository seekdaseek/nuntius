import React, { createContext, useContext, type PropsWithChildren } from 'react'
import { View } from 'react-native'
import { color } from '@/constants/app-styles'

/** True once Bricolage and Figtree are loaded (or failed to load). */
export const FontsReady = createContext(false)

/**
 * Wraps every screen. Until the fonts are in, a screen is an empty page of its
 * background colour (under the splash) and has no text at all.
 *
 * Android measures a Text with the font it has at that moment and does not
 * measure it again when the real font arrives. Screens drawn before the fonts
 * kept boxes sized for the fallback, so wider glyphs were cut: "nuntiu",
 * "Seeker verifiec", "Sign oui", "New permissior" on the first launch after a
 * restart (device check 11, 1 Oct). The navigator itself still mounts on the
 * first frame, so a notification tap on a cold start always has somewhere to
 * land (fd6c1d6).
 */
export function FontGate({ children }: PropsWithChildren) {
  const ready = useContext(FontsReady)
  if (!ready) return <View style={{ flex: 1, backgroundColor: color.paper }} testID="font-gate" />
  return <>{children}</>
}
