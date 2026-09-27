import React, { useEffect, useRef } from 'react'
import { Text, View } from 'react-native'
import { router } from 'expo-router'
import { Body, Button, Card, H1, H2, Muted, Row, Screen, theme } from '@/components/ui'
import { useNuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useClockIn, useDigest, useDigestPrefs } from '@/features/mandates/use-mandates'

/**
 * The daily clock-in. Opening this screen — from the morning push, the widget
 * or the home card — IS the clock-in: the streak counts days you looked at what
 * your permissions did, not days you performed a chore.
 */
export default function DigestScreen() {
  const auth = useNuntiusAuth()
  const digest = useDigest(auth)
  const clockIn = useClockIn(auth)
  const prefs = useDigestPrefs(auth)
  const done = useRef(false)
  const seeker = Boolean(auth?.sgtMint)

  useEffect(() => {
    if (auth && seeker && !done.current) {
      done.current = true
      clockIn.mutate()
    }
  }, [auth, seeker, clockIn])

  if (!auth) {
    return (
      <Screen>
        <Muted>Sign in first.</Muted>
      </Screen>
    )
  }

  const d = digest.data?.digest
  const streak = clockIn.data?.streak ?? digest.data?.streak
  const hour = digest.data?.prefs?.hour ?? 8

  return (
    <Screen>
      <H1>Clock in</H1>
      {seeker && streak ? (
        <Card tone="amber">
          <Row>
            <Text style={{ fontSize: 40, fontWeight: '800', color: theme.ink }}>{streak.current}</Text>
            <View style={{ flex: 1 }}>
              <Body strong>day{streak.current === 1 ? '' : 's'} in a row</Body>
              <Muted>
                {clockIn.data?.firstToday
                  ? 'Clocked in for today.'
                  : streak.clockedInToday
                    ? 'Already clocked in today.'
                    : ''}
                {` Best: ${streak.best}.`}
              </Muted>
            </View>
          </Row>
        </Card>
      ) : !seeker ? (
        <Card>
          <Muted>The streak and the morning digest come with Seeker verification. Today’s summary is below.</Muted>
        </Card>
      ) : null}

      {digest.isLoading ? <Muted>Reading the chain…</Muted> : null}
      {d ? (
        <>
          <Card tone={d.title.startsWith('1 pull refused') || d.title.includes('refused') ? 'refused' : 'chain'}>
            <Body strong>{d.title}</Body>
            <Muted>{d.body.replace(' Tap to clock in.', '')}</Muted>
          </Card>
          <H2>Last 24 hours</H2>
          {d.lines.length === 0 ? <Muted>Nothing to report.</Muted> : null}
          {d.lines.map((l, i) => (
            <Card
              key={i}
              tone={l.startsWith('Refused') ? 'refused' : l.includes('outside nuntius') ? 'amber' : 'plain'}
            >
              <Body>{l}</Body>
            </Card>
          ))}
        </>
      ) : null}

      {seeker ? (
        <>
          <H2>Morning digest</H2>
          <Card>
            <Row>
              <Button
                title="−"
                kind="secondary"
                onPress={() => prefs.mutate({ hour: (hour + 23) % 24, enabled: true })}
              />
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Body strong>{`${String(hour).padStart(2, '0')}:00`}</Body>
                <Muted>{digest.data?.prefs ? 'every day, your time' : 'not set yet'}</Muted>
              </View>
              <Button
                title="+"
                kind="secondary"
                onPress={() => prefs.mutate({ hour: (hour + 1) % 24, enabled: true })}
              />
            </Row>
          </Card>
        </>
      ) : null}
      <Button title="See permissions" kind="secondary" onPress={() => router.replace('/')} />
    </Screen>
  )
}
