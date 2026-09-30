import React, { useEffect, useRef } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Button, Muted, Note, Screen, Section, Title, color, font } from '@/components/ui'
import { radius } from '@/constants/app-styles'
import { useNuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useClockIn, useDigest, useDigestPrefs } from '@/features/mandates/use-mandates'
import { tzOffsetMin } from '@/core/format'
import { lineTone, longDate, weekSlots, type SlotState } from '@/core/home-model'

/**
 * Clock in. A punch card of the week, the last 24 hours as a short list, and
 * one call to action. The streak counts days you looked at what your
 * permissions did, not days you performed a chore.
 */
export default function ClockInScreen() {
  const auth = useNuntiusAuth()
  const digest = useDigest(auth)
  const clockIn = useClockIn(auth)
  const prefs = useDigestPrefs(auth)
  const seeker = Boolean(auth?.sgtMint)
  const opened = useRef(false)

  // Arriving from the morning push or the widget is itself the clock-in.
  useEffect(() => {
    if (auth && seeker && !opened.current) {
      opened.current = true
      clockIn.mutate()
    }
  }, [auth, seeker, clockIn])

  if (!auth) {
    return (
      <Screen back>
        <Muted>Sign in first.</Muted>
      </Screen>
    )
  }

  const d = digest.data
  const streak = clockIn.data?.streak ?? d?.streak
  const days = clockIn.data?.days ?? d?.days ?? []
  const today = d?.today ?? new Date(Date.now() + tzOffsetMin() * 60_000).toISOString().slice(0, 10)
  const slots = weekSlots(days, today)
  const hour = d?.prefs?.hour ?? 8
  const done = streak?.clockedInToday ?? false

  const footer = seeker ? (
    <Button
      big
      title={done ? 'Clocked in for today' : 'Clock in'}
      disabled={done}
      busy={clockIn.isPending}
      onPress={() => clockIn.mutate()}
      testID="clock-in"
    />
  ) : null

  return (
    <Screen back footer={footer}>
      <Title style={{ marginTop: 6 }}>Clock in</Title>
      <Muted>{longDate(Date.now(), tzOffsetMin())}</Muted>

      {seeker ? (
        <View style={s.punch}>
          <Text style={s.streak}>Day {streak?.current ?? 0} in a row</Text>
          <Text style={s.best}>Best run: {streak?.best ?? 0} days</Text>
          <View style={s.days}>
            {slots.map((x) => (
              <View key={x.day} style={s.dayCol}>
                <Text style={s.dayLabel}>{x.label}</Text>
                <Hole state={x.state} />
              </View>
            ))}
          </View>
        </View>
      ) : (
        <Note tone="foreign">The streak and the morning digest come with Seeker verification.</Note>
      )}

      <Section>Since yesterday</Section>
      {digest.isLoading ? <Muted>Reading the chain…</Muted> : null}
      {d ? (
        <View style={s.list}>
          {(d.digest.lines.length ? d.digest.lines : ['Nothing moved and nothing was refused.']).map((line, i, all) => (
            <View key={i} style={[s.li, i === all.length - 1 ? null : s.liBorder]}>
              <View style={[s.dot, { backgroundColor: DOT[lineTone(line)] }]} />
              <Text style={s.liText}>{line}</Text>
            </View>
          ))}
          {d.digest.expiringSoon.length === 0 ? (
            <View style={[s.li, s.liTop]}>
              <View style={[s.dot, { backgroundColor: color.ink2 }]} />
              <Text style={s.liText}>Nothing expires this week</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {seeker ? (
        <>
          <Section>Morning digest</Section>
          <View style={s.hourRow}>
            <Button
              title="Earlier"
              kind="outline"
              onPress={() => prefs.mutate({ hour: (hour + 23) % 24, enabled: true })}
            />
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={s.hour}>{`${String(hour).padStart(2, '0')}:00`}</Text>
              <Muted style={{ fontSize: 13 }}>{d?.prefs ? 'every day, your time' : 'not set yet'}</Muted>
            </View>
            <Button
              title="Later"
              kind="outline"
              onPress={() => prefs.mutate({ hour: (hour + 1) % 24, enabled: true })}
            />
          </View>
        </>
      ) : null}
    </Screen>
  )
}

const DOT = { moved: color.moved, refused: color.refused, foreign: color.foreign, neutral: color.ink2 }

function Hole({ state }: { state: SlotState }) {
  if (state === 'punched' || state === 'todayPunched') {
    return (
      <View style={[s.hole, s.holeOn, state === 'todayPunched' ? s.holeTodayRing : null]}>
        {/* The one shadow in the app: the inside of a punched hole. */}
        <View style={s.holeShade} />
      </View>
    )
  }
  if (state === 'today') return <View style={[s.hole, s.holeToday]} />
  return <View style={[s.hole, s.holeFuture]} />
}

const s = StyleSheet.create({
  punch: { backgroundColor: color.signal, borderRadius: radius.punch, padding: 18, marginTop: 6 },
  streak: { fontFamily: font.display, fontSize: 34, lineHeight: 36, letterSpacing: -0.5, color: color.white },
  best: { fontFamily: font.regular, fontSize: 15, color: color.onSignalSoft, marginTop: 4 },
  days: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  dayCol: { alignItems: 'center', gap: 6 },
  dayLabel: { fontFamily: font.semibold, fontSize: 12, color: color.onSignalFaint },
  hole: { width: 34, height: 34, borderRadius: 17, overflow: 'hidden' },
  holeOn: { backgroundColor: color.paper },
  holeShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 34,
    borderRadius: 17,
    borderTopWidth: 4,
    borderColor: color.holeShade,
  },
  holeTodayRing: { borderWidth: 2, borderColor: color.white },
  holeToday: { borderWidth: 2, borderColor: color.white, backgroundColor: color.holeToday },
  holeFuture: { borderWidth: 2, borderStyle: 'dashed', borderColor: color.holeDash },
  list: { backgroundColor: color.card, borderRadius: radius.panel, paddingHorizontal: 16, paddingVertical: 4 },
  li: { flexDirection: 'row', gap: 12, paddingVertical: 13 },
  liBorder: { borderBottomWidth: 1.5, borderBottomColor: color.line },
  liTop: { borderTopWidth: 1.5, borderTopColor: color.line },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
  liText: { fontFamily: font.medium, fontSize: 14.5, lineHeight: 20, color: color.ink, flex: 1 },
  hourRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: color.card,
    borderRadius: radius.card,
    padding: 12,
  },
  hour: { fontFamily: font.display, fontSize: 26, color: color.ink },
})
