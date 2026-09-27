import React, { useEffect, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import Clipboard from '@react-native-clipboard/clipboard'
import { Body, Button, Card, H1, Muted, Row, Screen, s, theme } from '@/components/ui'
import { isUserCancellation, useNuntiusAuth } from '@/features/account/use-nuntius-auth'
import { useGrantMandate, type GrantStep } from '@/features/mandates/use-mandates'
import { api, type MandateText } from '@/features/mandates/mandates-api'
import {
  checkForm,
  PERIOD_OPTIONS,
  sanitizeAmount,
  UNTIL_OPTIONS,
  type MandateForm,
  type PeriodKey,
} from '@/core/mandate-form'

/**
 * The rule-creation screen. One sentence, four blanks, one approval:
 *
 *   Let [name] ([address]) take up to [amount] USDC every [period] for [N] days.
 *
 * The sentence the user approves is the server's preview of the exact terms
 * the transaction will carry, so what they read is what the chain enforces.
 */
export default function NewMandateScreen() {
  const auth = useNuntiusAuth()
  // The token the server offers (mainnet config: USDC only).
  const { symbol = 'USDC' } = useLocalSearchParams<{ symbol?: string }>()
  const [form, setForm] = useState<MandateForm>({ label: '', payee: '', amount: '', period: 'week', untilDays: 90 })
  const [preview, setPreview] = useState<{ text: MandateText; allowed: boolean; upgrade: string | null } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [step, setStep] = useState<GrantStep | null>(null)
  const grant = useGrantMandate(auth, setStep)
  const check = checkForm(form, auth?.address ?? null)
  const set = <K extends keyof MandateForm>(k: K, v: MandateForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  // Server preview, debounced: the sentence below is built from the same parsing as the transaction.
  useEffect(() => {
    if (!auth || !check.ok) {
      setPreview(null)
      return
    }
    const t = setTimeout(() => {
      api
        .preview(auth.session, { ...form, symbol })
        .then((p) => {
          setPreview(p)
          setPreviewError(null)
        })
        .catch((e: unknown) => {
          setPreview(null)
          setPreviewError(e instanceof Error ? e.message : 'preview failed')
        })
    }, 350)
    return () => clearTimeout(t)
  }, [auth, form, check.ok, symbol])

  if (!auth) {
    return (
      <Screen>
        <Muted>Sign in first.</Muted>
      </Screen>
    )
  }

  const cancelled = grant.isError && isUserCancellation(grant.error)
  const busy = grant.isPending

  return (
    <Screen>
      <H1>New mandate</H1>
      <Muted>Fill the sentence. You approve it once in Seed Vault.</Muted>

      <Card>
        <Body strong>Let</Body>
        <TextInput
          style={s.input}
          placeholder="Name (e.g. Rent to Ana)"
          placeholderTextColor={theme.muted}
          value={form.label}
          onChangeText={(v) => set('label', v)}
          maxLength={40}
          testID="label"
        />
        <Row>
          <TextInput
            style={[s.input, { flex: 1 }, check.field === 'payee' && form.payee ? s.inputError : null]}
            placeholder="Payee address"
            placeholderTextColor={theme.muted}
            value={form.payee}
            onChangeText={(v) => set('payee', v.trim())}
            autoCapitalize="none"
            autoCorrect={false}
            testID="payee"
          />
          <Button
            title="Paste"
            kind="secondary"
            onPress={() => {
              Clipboard.getString()
                .then((v) => set('payee', v.trim()))
                .catch(() => {})
            }}
          />
        </Row>
        <Body strong>take up to</Body>
        <Row>
          <TextInput
            style={[s.input, { flex: 1 }, check.field === 'amount' && form.amount ? s.inputError : null]}
            placeholder="10"
            placeholderTextColor={theme.muted}
            keyboardType="decimal-pad"
            value={form.amount}
            onChangeText={(v) => set('amount', sanitizeAmount(v))}
            testID="amount"
          />
          <Body strong>{symbol}</Body>
        </Row>
        <Body strong>every</Body>
        <Chips<PeriodKey> options={PERIOD_OPTIONS} value={form.period} onChange={(v) => set('period', v)} />
        <Body strong>for the next</Body>
        <Chips<number>
          options={UNTIL_OPTIONS.map((d) => ({ key: d, label: `${d} days` }))}
          value={form.untilDays}
          onChange={(v) => set('untilDays', v)}
        />
      </Card>

      {check.hint && (form.payee || form.amount) ? <Muted>{check.hint}</Muted> : null}
      {previewError ? <Text style={{ color: theme.refused }}>{previewError}</Text> : null}

      {preview ? (
        <Card tone="chain">
          <Body strong>{preview.text.headline}</Body>
          <Body>{preview.text.schedule}</Body>
          <Muted>{preview.text.guarantee}</Muted>
          <Muted>{preview.text.exit}</Muted>
        </Card>
      ) : null}
      {preview && !preview.allowed ? <Text style={{ color: theme.amber }}>{preview.upgrade}</Text> : null}

      <Button
        title={
          step === 'signing' && busy
            ? 'Approve in Seed Vault…'
            : step === 'confirming' && busy
              ? 'Confirming on chain…'
              : 'Authorize with one approval'
        }
        onPress={() => grant.mutate({ ...form, label: form.label.trim(), symbol })}
        disabled={!check.ok || !preview || !preview.allowed}
        busy={busy}
        testID="authorize"
      />

      {grant.isSuccess ? (
        <Card tone="chain">
          <Body strong>Live. The chain now enforces it.</Body>
          <Muted>You will get a receipt on this phone for every pull.</Muted>
          <Button title="Done" onPress={() => router.back()} />
        </Card>
      ) : null}
      {grant.isError ? (
        <Text style={{ color: cancelled ? theme.muted : theme.refused }}>
          {cancelled ? 'Approval dismissed. Nothing was granted.' : `Not granted: ${grant.error.message}`}
        </Text>
      ) : null}
    </Screen>
  )
}

function Chips<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { key: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o.key === value
        return (
          <Pressable
            key={String(o.key)}
            onPress={() => onChange(o.key)}
            style={[s.chip, on && s.chipOn]}
            accessibilityState={{ selected: on }}
          >
            <Text style={[s.chipText, on && s.chipTextOn]}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
