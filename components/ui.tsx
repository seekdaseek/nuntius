import React, { useState, type PropsWithChildren } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg'
import { color, font, radius, space, tabular } from '@/constants/app-styles'

/**
 * nuntius UI kit. Reference: design/nuntius-mockups-v1.png. Colour carries
 * meaning: signal is the brand and the action, moved green is money that left
 * inside the cap, raspberry is the chain saying no, amber is another app.
 */

// ---------- type ----------

type TP = PropsWithChildren<{ style?: StyleProp<TextStyle>; numberOfLines?: number }>
export const Title = ({ children, style }: TP) => <Text style={[t.title, style]}>{children}</Text>
export const Display = ({ children, style }: TP) => <Text style={[t.display, style]}>{children}</Text>
export const Body = ({ children, style, numberOfLines }: TP) => (
  <Text style={[t.body, style]} numberOfLines={numberOfLines}>
    {children}
  </Text>
)
export const Muted = ({ children, style, numberOfLines }: TP) => (
  <Text style={[t.muted, style]} numberOfLines={numberOfLines}>
    {children}
  </Text>
)
export const Label = ({ children, style }: TP) => <Text style={[t.label, style]}>{children}</Text>
export const Section = ({ children, style }: TP) => <Text style={[t.section, style]}>{children}</Text>

// ---------- layout ----------

export function Screen({
  children,
  tint,
  footer,
  back,
  scroll = true,
}: PropsWithChildren<{ tint?: 'moved' | 'refused'; footer?: React.ReactNode; back?: boolean; scroll?: boolean }>) {
  const body = (
    <>
      {back ? <BackArrow /> : null}
      {children}
    </>
  )
  return (
    <View style={l.root}>
      {tint ? <TintBackground tint={tint} /> : null}
      <SafeAreaView style={l.flex} edges={['top', 'left', 'right']}>
        {scroll ? <ScrollView contentContainerStyle={l.pad}>{body}</ScrollView> : <View style={l.pad}>{body}</View>}
      </SafeAreaView>
      {footer ? <Footer>{footer}</Footer> : null}
    </View>
  )
}

/**
 * The call to action under a screen's scroll area, never over it: the list ends
 * above it, so no row, account line or confirmation hides behind the button
 * (device check 2, 30 Sep). Clears the system navigation bar.
 */
export function Footer({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets()
  return <View style={[l.footer, { paddingBottom: Math.max(16, insets.bottom + 8) }]}>{children}</View>
}

/**
 * An opaque band behind the status bar, for screens whose content scrolls up
 * into it (Home under its hero). Shown only once the content has moved, so the
 * hero's colour still runs to the top edge at rest.
 */
export function StatusBarScrim({ visible }: { visible: boolean }) {
  const insets = useSafeAreaInsets()
  if (!visible || insets.top === 0) return null
  return <View pointerEvents="none" style={[l.scrim, { height: insets.top }]} />
}

/**
 * The mockup's back arrow: Figtree SemiBold's own "←" (U+2190) at 22px, drawn
 * as a shape from the font's outline, so the button carries no text arrow.
 */
const BACK_ARROW =
  'M415-499L151-247L58-298L349-569L415-499ZM682-347L682-250L132-250L132-347L682-347ZM417-100L352-29L58-298L150-350L417-100Z'

export function BackArrow() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={() => router.back()}
      hitSlop={16}
      style={l.back}
    >
      <Svg width={16.456} height={26.4} viewBox="0 -950 748 1200">
        <Path d={BACK_ARROW} fill={color.ink} />
      </Svg>
    </Pressable>
  )
}

function TintBackground({ tint }: { tint: 'moved' | 'refused' }) {
  const top = tint === 'moved' ? color.movedDeep : color.refusedDeep
  const mid = tint === 'moved' ? color.moved50 : color.refused50
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id="tint" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={top} />
          <Stop offset="0.55" stopColor={mid} />
          <Stop offset="1" stopColor={color.paper} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill="url(#tint)" />
    </Svg>
  )
}

/** Full-bleed signal gradient block with a 32 bottom radius: the Home hero. */
export function Hero({ children }: PropsWithChildren) {
  return (
    <View style={l.hero}>
      <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 100">
        <Defs>
          <LinearGradient id="hero" x1="0" y1="0" x2="0.55" y2="1">
            <Stop offset="0" stopColor={color.heroFrom} />
            <Stop offset="1" stopColor={color.heroTo} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100" height="100" fill="url(#hero)" />
      </Svg>
      <SafeAreaView edges={['top', 'left', 'right']} style={l.heroInner}>
        {children}
      </SafeAreaView>
    </View>
  )
}

export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[l.card, style]}>{children}</View>
}

export function Row({ children, gap = 10, style }: PropsWithChildren<{ gap?: number; style?: StyleProp<ViewStyle> }>) {
  return <View style={[l.row, { gap }, style]}>{children}</View>
}

/** Mint, raspberry or amber box with one message. */
export function Note({ children, tone = 'moved' }: PropsWithChildren<{ tone?: 'moved' | 'refused' | 'foreign' }>) {
  const bg = tone === 'moved' ? color.moved50 : tone === 'refused' ? color.refused50 : color.foreign50
  const fg = tone === 'moved' ? color.movedInk : tone === 'refused' ? color.refusedInk : color.foreignInk
  return (
    <View style={[l.note, { backgroundColor: bg }]}>
      <Text style={[t.noteText, { color: fg }]}>{children}</Text>
    </View>
  )
}

// ---------- brand ----------

/** The mark: a signal arch "n" that reaches up to a mint bar and stops short of it. */
export function Mark({ size = 26, tile = color.paper }: { size?: number; tile?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 320 320">
      <Rect width="320" height="320" rx="80" fill={tile} />
      <Rect x="72" y="56" width="176" height="26" rx="13" fill={color.moved} />
      <Path
        d="M98 250 V170 a62 62 0 0 1 124 0 V250"
        fill="none"
        stroke={color.signal}
        strokeWidth={44}
        strokeLinecap="round"
      />
    </Svg>
  )
}

export function Wordmark({ light }: { light?: boolean }) {
  return (
    <View style={l.row}>
      <Mark />
      <Text style={[t.word, light ? { color: color.white } : null]}>nuntius</Text>
    </View>
  )
}

// ---------- chips and buttons ----------

type ChipTone = 'moved' | 'refused' | 'signal' | 'foreign' | 'glass' | 'plain'
const CHIP: Record<ChipTone, { bg: string; fg: string }> = {
  moved: { bg: color.moved50, fg: color.movedInk },
  refused: { bg: color.refused50, fg: color.refusedInk },
  signal: { bg: color.signal50, fg: color.signal },
  foreign: { bg: color.foreign50, fg: color.foreignInk },
  glass: { bg: color.glass, fg: color.white },
  plain: { bg: color.card, fg: color.ink2 },
}

export function Chip({ label, tone = 'plain' }: { label: string; tone?: ChipTone }) {
  return (
    <View style={[l.chip, { backgroundColor: CHIP[tone].bg }]}>
      <Text style={[t.chip, { color: CHIP[tone].fg }]}>{label}</Text>
    </View>
  )
}

/** A choice row: selected is ink, the rest are white. */
export function Segments<T extends string | number>({
  options,
  value,
  onChange,
  testIDPrefix,
}: {
  options: { key: T; label: string }[]
  value: T
  onChange: (v: T) => void
  testIDPrefix?: string
}) {
  return (
    <View style={l.seg}>
      {options.map((o) => {
        const on = o.key === value
        return (
          <Pressable
            key={String(o.key)}
            testID={testIDPrefix ? `${testIDPrefix}-${o.key}` : undefined}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.key)}
            style={[l.segItem, on ? l.segOn : null]}
          >
            <Text style={[t.seg, on ? t.segOn : null]}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

type ButtonKind = 'signal' | 'ink' | 'revoke' | 'ghost' | 'outline'
export function Button({
  title,
  onPress,
  kind = 'signal',
  disabled,
  busy,
  testID,
  big,
}: {
  title: string
  onPress: () => void
  kind?: ButtonKind
  disabled?: boolean
  busy?: boolean
  testID?: string
  /** The 20-radius full-width call to action. */
  big?: boolean
}) {
  const bg: Record<ButtonKind, ViewStyle> = {
    signal: { backgroundColor: color.signal },
    ink: { backgroundColor: color.ink },
    revoke: { backgroundColor: color.refused50 },
    ghost: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: color.line },
    outline: { backgroundColor: color.card, borderWidth: 1.5, borderColor: color.line },
  }
  const fg = kind === 'signal' || kind === 'ink' ? color.white : kind === 'revoke' ? color.refusedInk : color.ink
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        big ? l.cta : l.btn,
        bg[kind],
        (disabled || busy) && (big ? l.ctaDisabled : l.disabled),
        pressed && { opacity: 0.85 },
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : null}
      <Text style={[big ? t.cta : t.btn, { color: big && disabled && !busy ? color.signal : fg }]}>{title}</Text>
    </Pressable>
  )
}

// ---------- the cap meter ----------

/**
 * The signature element: green fill for what was taken this period, and a
 * hard ink stop at the cap. Used on every card, receipt and (natively) the widget.
 */
export function CapMeter({ takenShare, left, right }: { takenShare: number; left?: string; right?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, takenShare)) * 1000) / 10
  return (
    <View accessibilityLabel={`${pct} percent of the cap taken this period`}>
      <View style={l.meter}>
        <View style={[l.meterFill, { width: `${pct}%` }]} />
        <View style={l.meterStop} />
      </View>
      {left || right ? (
        <View style={l.meterLabels}>
          <Text style={t.meterLabel}>{left}</Text>
          <Text style={t.meterLabel}>{right}</Text>
        </View>
      ) : null}
    </View>
  )
}

// ---------- receipts ----------

/** A white slip with perforated top and bottom edges (radius 7 every 20). */
export function Slip({ children }: PropsWithChildren) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout
    if (!size || size.w !== width || size.h !== height) setSize({ w: width, h: height })
  }
  return (
    <View onLayout={onLayout} style={l.slip}>
      {size ? (
        <Svg style={StyleSheet.absoluteFill} width={size.w} height={size.h}>
          <Path d={slipPath(size.w, size.h)} fill={color.card} />
        </Svg>
      ) : null}
      {children}
    </View>
  )
}

export function slipPath(w: number, h: number, r = 7, step = 20): string {
  const n = Math.max(1, Math.floor(w / step))
  const pitch = w / n
  let d = `M0 0`
  for (let i = 0; i < n; i++) {
    const cx = pitch * i + pitch / 2
    d += ` L${cx - r} 0 A${r} ${r} 0 0 0 ${cx + r} 0`
  }
  d += ` L${w} 0 L${w} ${h}`
  for (let i = n - 1; i >= 0; i--) {
    const cx = pitch * i + pitch / 2
    d += ` L${cx + r} ${h} A${r} ${r} 0 0 0 ${cx - r} ${h}`
  }
  return `${d} L0 ${h} Z`
}

export function KV({ k, v, testID }: { k: string; v: string; testID?: string }) {
  return (
    <View style={l.kv} testID={testID}>
      <Text style={t.kvK}>{k}</Text>
      <Text style={t.kvV}>{v}</Text>
    </View>
  )
}

export function Stamp({ label }: { label: string }) {
  return (
    <View style={l.stamp}>
      <Text style={t.stamp}>{label}</Text>
    </View>
  )
}

// ---------- styles ----------

const t = StyleSheet.create({
  title: { fontFamily: font.display, fontSize: 30, lineHeight: 33, letterSpacing: -0.6, color: color.ink },
  display: { fontFamily: font.display, fontSize: 31, lineHeight: 35, letterSpacing: -0.6, color: color.ink },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: color.ink },
  muted: { fontFamily: font.regular, fontSize: 14.5, lineHeight: 21, color: color.ink2 },
  label: { fontFamily: font.medium, fontSize: 13, color: color.ink2 },
  section: { fontFamily: font.semibold, fontSize: 15, color: color.ink, marginTop: 14 },
  word: { fontFamily: font.display, fontSize: 26, letterSpacing: -0.5, color: color.ink },
  chip: { fontFamily: font.semibold, fontSize: 13 },
  seg: { fontFamily: font.semibold, fontSize: 14, color: color.ink2 },
  segOn: { color: color.white },
  btn: { fontFamily: font.semibold, fontSize: 14 },
  cta: { fontFamily: font.bold, fontSize: 17 },
  meterLabel: { fontFamily: font.medium, fontSize: 13, color: color.ink2, ...tabular },
  noteText: { fontFamily: font.medium, fontSize: 14.5, lineHeight: 21 },
  kvK: { fontFamily: font.medium, fontSize: 14, color: color.ink2 },
  kvV: { fontFamily: font.medium, fontSize: 14, color: color.ink, textAlign: 'right', flexShrink: 1, ...tabular },
  stamp: { fontFamily: font.display, fontSize: 17, lineHeight: 19, color: color.refused, textAlign: 'center' },
})

const l = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  flex: { flex: 1 },
  pad: { paddingHorizontal: space.side, paddingTop: 8, paddingBottom: 32, gap: space.cardGap },
  footer: { paddingHorizontal: space.side, paddingTop: 12, gap: 12, backgroundColor: color.paper },
  scrim: { position: 'absolute', left: 0, right: 0, top: 0, backgroundColor: color.paper },
  hero: {
    borderBottomLeftRadius: radius.hero,
    borderBottomRightRadius: radius.hero,
    overflow: 'hidden',
  },
  heroInner: { paddingHorizontal: space.side, paddingTop: 8, paddingBottom: 24, gap: 8 },
  card: { backgroundColor: color.card, borderRadius: radius.card, padding: 16, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  note: { borderRadius: radius.panel, paddingVertical: 14, paddingHorizontal: 16 },
  chip: { borderRadius: radius.chip, paddingVertical: 7, paddingHorizontal: 12, alignSelf: 'flex-start' },
  seg: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  segItem: { borderRadius: radius.chip, paddingVertical: 9, paddingHorizontal: 14, backgroundColor: color.card },
  segOn: { backgroundColor: color.ink },
  btn: {
    borderRadius: radius.button,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  cta: {
    borderRadius: radius.cta,
    paddingVertical: 18,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.45 },
  back: { alignSelf: 'flex-start', height: 35, justifyContent: 'center' },
  // A floating call to action must stay opaque, or the list shows through it.
  ctaDisabled: { backgroundColor: color.signal50 },
  meter: { height: 12, borderRadius: radius.meter, backgroundColor: color.track, marginRight: 8 },
  meterFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: radius.meter,
    backgroundColor: color.moved,
  },
  meterStop: {
    position: 'absolute',
    right: -8,
    top: -7,
    width: 5,
    height: 26,
    borderRadius: radius.stop,
    backgroundColor: color.ink,
  },
  meterLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, gap: 8 },
  slip: { borderRadius: radius.slip, paddingTop: 26, paddingHorizontal: 22, paddingBottom: 22, gap: 6 },
  kv: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: 1.5,
    borderStyle: 'dashed',
    borderTopColor: color.line,
  },
  stamp: {
    alignSelf: 'flex-start',
    borderWidth: 3,
    borderColor: color.refused,
    borderRadius: radius.stamp,
    paddingVertical: 8,
    paddingHorizontal: 12,
    transform: [{ rotate: '-6deg' }],
    marginVertical: 4,
  },
})

export { color, font }
