import React, { useState } from 'react'
import { StyleSheet, TextInput } from 'react-native'
import { router } from 'expo-router'
import Clipboard from '@react-native-clipboard/clipboard'
import { useMutation } from '@tanstack/react-query'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { Button, Card, KV, Label, Muted, Note, Screen, Segments, Title, color, font } from '@/components/ui'
import { radius } from '@/constants/app-styles'
import { isUserCancellation, useNuntiusAuth } from '@/features/account/use-nuntius-auth'
import { api, untilLanded, type LaunchInfo } from '@/features/mandates/mandates-api'
import { signAndSend } from '@/features/wallet/sign-and-send'
import { checkTransaction, LAUNCH_CONFIGS, MINTS } from '@/core/tx-check'
import { checkLaunch, demandWords, FEES_LINE, launchesOn, routeWords } from '@/core/back-copy'
import { useMandateList } from '@/features/mandates/use-mandates'

/**
 * Launch a token on a Meteora Dynamic Bonding Curve made for subscription backing: a pool on
 * nuntius's fixed config for SKR or USDC (a flat 1% fee, migrating to DAMM v2). One Seed Vault
 * signature; the server signs only for the token's fresh mint key. The transaction check
 * accepts only a pool on the config this build pins. Verified Seekers only.
 */
export default function LaunchScreen() {
  const auth = useNuntiusAuth()
  const { chain, identity } = useMobileWallet()
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [quote, setQuote] = useState<'SKR' | 'USDC'>('SKR')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState('')
  const config = LAUNCH_CONFIGS[quote] ?? null
  const check = checkLaunch({ name, symbol })
  const list = useMandateList(auth)
  const launch = useMutation({
    mutationFn: async (): Promise<LaunchInfo> => {
      if (!auth) throw new Error('not signed in')
      if (!config) throw new Error(`This build cannot launch in ${quote} yet.`)
      const created = await api.launchCreate(auth.session, {
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        quote,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(image.trim() ? { image: image.trim() } : {}),
      })
      await signAndSend(chain, identity, auth.address, created.transactionBase64, (base64) =>
        checkTransaction(base64, {
          kind: 'launch',
          wallet: auth.address,
          baseMint: created.baseMint,
          quoteMint: MINTS[quote]!.mint,
          config,
        }),
      )
      return (await untilLanded(() => api.launchConfirm(auth.session, created.baseMint), ['not_on_chain_yet'])).launch
    },
  })

  if (!auth) {
    return (
      <Screen back>
        <Muted>Sign in first.</Muted>
      </Screen>
    )
  }
  // v1.0.1: hidden unless the server turns subscription launches on.
  if (!launchesOn(list.data)) {
    return (
      <Screen back>
        <Muted>Launching a token is not available in this version.</Muted>
      </Screen>
    )
  }

  if (launch.data) {
    const l = launch.data
    return (
      <Screen back>
        <Title style={{ marginTop: 6 }}>{l.symbol ?? 'Your token'} is live</Title>
        <Card>
          <KV k="Now" v={routeWords(l)} />
          <KV k="Committed" v={demandWords(l.committed)} />
          <KV k="Pool" v={`${l.pool.slice(0, 6)}…${l.pool.slice(-4)}`} />
        </Card>
        <Muted>Share the pool address. Anyone with nuntius can back it with a capped weekly buy.</Muted>
        <Button
          title="Copy pool address"
          kind="outline"
          onPress={() => Clipboard.setString(l.pool)}
          testID="copy-pool"
        />
        <Button
          title={`Back ${l.symbol ?? 'it'} yourself`}
          onPress={() => router.push({ pathname: '/back', params: { pool: l.pool } })}
          testID="back-own"
        />
      </Screen>
    )
  }

  return (
    <Screen
      back
      footer={
        <Button
          big
          testID="launch"
          title={launch.isPending ? 'Waiting for Seed Vault' : 'Launch in Seed Vault'}
          busy={launch.isPending}
          disabled={!check.ok || !config}
          onPress={() => launch.mutate()}
        />
      }
    >
      <Title style={{ marginTop: 6 }}>Launch a token</Title>
      <Muted>
        A bonding curve on Meteora built for weekly backers: a flat 1% fee, priced in {quote}. The last token before it
        fills costs about 4.1 times the first. When backers fill it, it moves to a regular pool and their weekly buys
        follow it there.
      </Muted>
      <Label>Name</Label>
      <TextInput
        testID="launch-name"
        style={s.input}
        value={name}
        maxLength={32}
        onChangeText={setName}
        placeholder="natXbuilder"
        placeholderTextColor={color.slotPlaceholder}
      />
      <Label>Symbol</Label>
      <TextInput
        testID="launch-symbol"
        style={s.input}
        value={symbol}
        maxLength={10}
        autoCapitalize="characters"
        onChangeText={(v) => setSymbol(v.toUpperCase())}
        placeholder="NATX"
        placeholderTextColor={color.slotPlaceholder}
      />
      <Label>Priced in</Label>
      <Segments
        options={[
          { key: 'SKR', label: 'SKR' },
          { key: 'USDC', label: 'USDC' },
        ]}
        value={quote}
        onChange={(v) => setQuote(v as 'SKR' | 'USDC')}
        testIDPrefix="launch-quote"
      />
      <Label>Description (optional)</Label>
      <TextInput
        testID="launch-description"
        style={s.input}
        value={description}
        maxLength={200}
        onChangeText={setDescription}
        placeholder="One plain sentence, no promises"
        placeholderTextColor={color.slotPlaceholder}
      />
      <Label>Image link (optional)</Label>
      <TextInput
        testID="launch-image"
        style={s.input}
        value={image}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={setImage}
        placeholder="https://…"
        placeholderTextColor={color.slotPlaceholder}
      />
      {!check.ok && (name || symbol) ? <Muted>{check.hint}</Muted> : null}
      {!config ? <Note tone="refused">This build cannot launch in {quote} yet.</Note> : null}
      <Note tone="foreign">
        You pay the pool’s accounts and sign once. Name, symbol and image are permanent. {FEES_LINE} nuntius never holds
        the token or its keys.
      </Note>
      {launch.isError && !isUserCancellation(launch.error) ? <Note tone="refused">{launch.error.message}</Note> : null}
    </Screen>
  )
}

const s = StyleSheet.create({
  input: {
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: color.line,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: font.medium,
    fontSize: 15,
    color: color.ink,
    backgroundColor: color.card,
  },
})
