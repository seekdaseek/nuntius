import React, { type PropsWithChildren } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

/**
 * nuntius visual language: warm paper, ink text, one green that only ever
 * means "enforced by the chain", one red that only ever means "refused".
 */
export const theme = {
  paper: '#F6F4EE',
  card: '#FFFFFF',
  ink: '#101418',
  muted: '#5C636B',
  faint: '#E4E1D8',
  chain: '#127A4E', // enforced by the program
  chainSoft: '#E3F2EA',
  refused: '#B3261E',
  refusedSoft: '#FBE9E7',
  amber: '#9A6200',
  amberSoft: '#FFF3DC',
  accent: '#1B1F24',
}

export function Screen({ children, scroll = true }: PropsWithChildren<{ scroll?: boolean }>) {
  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView contentContainerStyle={s.scroll}>{children}</ScrollView>
      ) : (
        <View style={s.scroll}>{children}</View>
      )}
    </SafeAreaView>
  )
}

export function Card({
  children,
  tone = 'plain',
  style,
}: PropsWithChildren<{ tone?: 'plain' | 'chain' | 'refused' | 'amber'; style?: ViewStyle }>) {
  const toneStyle =
    tone === 'chain' ? s.cardChain : tone === 'refused' ? s.cardRefused : tone === 'amber' ? s.cardAmber : null
  return <View style={[s.card, toneStyle, style]}>{children}</View>
}

export const H1 = ({ children }: PropsWithChildren) => <Text style={s.h1}>{children}</Text>
export const H2 = ({ children }: PropsWithChildren) => <Text style={s.h2}>{children}</Text>
export const Body = ({ children, strong }: PropsWithChildren<{ strong?: boolean }>) => (
  <Text style={[s.body, strong && s.strong]}>{children}</Text>
)
export const Muted = ({ children }: PropsWithChildren) => <Text style={s.muted}>{children}</Text>
export const Mono = ({ children }: PropsWithChildren) => <Text style={s.mono}>{children}</Text>

export function Pill({ label, tone = 'plain' }: { label: string; tone?: 'plain' | 'chain' | 'refused' | 'amber' }) {
  const bg =
    tone === 'chain'
      ? theme.chainSoft
      : tone === 'refused'
        ? theme.refusedSoft
        : tone === 'amber'
          ? theme.amberSoft
          : theme.faint
  const fg =
    tone === 'chain' ? theme.chain : tone === 'refused' ? theme.refused : tone === 'amber' ? theme.amber : theme.ink
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      <Text style={[s.pillText, { color: fg }]}>{label}</Text>
    </View>
  )
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  testID,
}: {
  title: string
  onPress: () => void
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost'
  disabled?: boolean
  busy?: boolean
  testID?: string
}) {
  const style =
    kind === 'primary' ? s.btnPrimary : kind === 'danger' ? s.btnDanger : kind === 'ghost' ? s.btnGhost : s.btnSecondary
  const textStyle = kind === 'primary' || kind === 'danger' ? s.btnTextLight : s.btnTextDark
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy }}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.btn, style, (disabled || busy) && s.btnDisabled, pressed && s.btnPressed]}
    >
      {busy ? <ActivityIndicator color={kind === 'primary' || kind === 'danger' ? '#fff' : theme.ink} /> : null}
      <Text style={textStyle}>{title}</Text>
    </Pressable>
  )
}

/** Share of the cap still available this period. Green because the ceiling is the program's. */
export function CapBar({ share }: { share: number }) {
  return (
    <View style={s.barTrack} accessibilityLabel={`${Math.round(share * 100)} percent of the cap left`}>
      <View style={[s.barFill, { width: `${Math.round(share * 100)}%` }]} />
    </View>
  )
}

export function Row({ children, gap = 8 }: PropsWithChildren<{ gap?: number }>) {
  return <View style={[s.row, { gap }]}>{children}</View>
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.paper },
  scroll: { padding: 16, gap: 14, paddingBottom: 48 },
  card: {
    backgroundColor: theme.card,
    borderRadius: 14,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: theme.faint,
  },
  cardChain: { backgroundColor: theme.chainSoft, borderColor: '#BFE0CD' },
  cardRefused: { backgroundColor: theme.refusedSoft, borderColor: '#F2C4BF' },
  cardAmber: { backgroundColor: theme.amberSoft, borderColor: '#F0D9A8' },
  h1: { fontSize: 28, fontWeight: '800', color: theme.ink, letterSpacing: -0.5 },
  h2: { fontSize: 17, fontWeight: '700', color: theme.ink, marginTop: 6 },
  body: { fontSize: 15, lineHeight: 21, color: theme.ink },
  strong: { fontWeight: '700' },
  muted: { fontSize: 13, lineHeight: 18, color: theme.muted },
  mono: { fontFamily: 'monospace', fontSize: 12, color: theme.muted },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '700' },
  btn: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  btnPrimary: { backgroundColor: theme.accent },
  btnSecondary: { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.faint },
  btnDanger: { backgroundColor: theme.refused },
  btnGhost: { backgroundColor: 'transparent' },
  btnDisabled: { opacity: 0.45 },
  btnPressed: { opacity: 0.8 },
  btnTextLight: { color: '#fff', fontSize: 15, fontWeight: '700' },
  btnTextDark: { color: theme.ink, fontSize: 15, fontWeight: '600' },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: theme.faint, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4, backgroundColor: theme.chain },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  input: {
    backgroundColor: theme.card,
    borderWidth: 1,
    borderColor: theme.faint,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: theme.ink,
  },
  inputError: { borderColor: theme.refused },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.faint,
    backgroundColor: theme.card,
  },
  chipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { fontSize: 14, color: theme.ink, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
})
