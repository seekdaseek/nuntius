import React, { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import Clipboard from '@react-native-clipboard/clipboard'
import { Button, Label, Muted, Note, Screen, Segments, Title, color, font } from '@/components/ui'
import { radius } from '@/constants/app-styles'
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
import { shortAddr, tzOffsetMin } from '@/core/format'
import { untilWords } from '@/core/home-model'

const PERIOD_WORD: Record<PeriodKey, string> = { hour: 'hour', day: 'day', week: 'week', '30days': '30 days' }

/**
 * New permission. The sentence IS the form:
 *
 *   Let [Ana] take up to [0.05] [USDC] every [day] until [30 Oct].
 *
 * Each slot is a tinted editable chip. The mint box below is the server's
 * preview of the exact terms the one transaction will carry.
 */
export default function NewPermissionScreen() {
  const auth = useNuntiusAuth()
  const { mints: mintsParam = 'USDC' } = useLocalSearchParams<{ mints?: string }>()
  const mints = mintsParam.split(',').filter(Boolean)
  const [symbol, setSymbol] = useState(mints[0] ?? 'USDC')
  const [form, setForm] = useState<MandateForm>({ label: '', payee: '', amount: '', period: 'day', untilDays: 30 })
  const [preview, setPreview] = useState<{ text: MandateText; allowed: boolean; upgrade: string | null } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [step, setStep] = useState<GrantStep | null>(null)
  const grant = useGrantMandate(auth, setStep)
  const check = checkForm(form, auth?.address ?? null)
  const set = <K extends keyof MandateForm>(k: K, v: MandateForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const amountRef = useRef<TextInput>(null)

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
      <Screen back>
        <Muted>Sign in first.</Muted>
      </Screen>
    )
  }

  const cycle = <T,>(list: readonly T[], v: T) => list[(list.indexOf(v) + 1) % list.length]!
  const cancelled = grant.isError && isUserCancellation(grant.error)
  const busy = grant.isPending
  const name = form.label.trim()

  const footer = grant.isSuccess ? (
    <Button big title="Done" onPress={() => router.back()} />
  ) : (
    <>
      <Muted style={s.note}>One approval now. You never sign a payment after this, and one approval ends it.</Muted>
      <Button
        big
        testID="authorize"
        title={
          step === 'signing' && busy
            ? 'Waiting for Seed Vault'
            : step === 'confirming' && busy
              ? 'Confirming on chain'
              : 'Approve in Seed Vault'
        }
        onPress={() => grant.mutate({ ...form, label: name, symbol })}
        disabled={!check.ok || !preview || !preview.allowed}
        busy={busy}
      />
    </>
  )

  return (
    <Screen back footer={footer}>
      <Title style={{ marginTop: 6 }}>New permission</Title>

      <View style={s.sentence} accessibilityLabel="Permission sentence">
        <Text style={s.word}>Let </Text>
        <TextInput
          testID="label"
          style={[s.slot, s.slotInput, { width: slotWidth(form.label || 'name') }]}
          value={form.label}
          placeholder="name"
          placeholderTextColor={color.slotPlaceholder}
          onChangeText={(v) => set('label', v)}
          maxLength={40}
        />
        <Text style={s.word}> take up to </Text>
        <TextInput
          ref={amountRef}
          testID="amount"
          style={[s.slot, s.slotInput, { width: slotWidth(form.amount || '0.05') }]}
          value={form.amount}
          placeholder="0.05"
          placeholderTextColor={color.slotPlaceholder}
          keyboardType="decimal-pad"
          onChangeText={(v) => set('amount', sanitizeAmount(v))}
        />
        <Text style={s.word}> </Text>
        <SlotButton label={symbol} onPress={() => setSymbol(cycle(mints, symbol))} testID="slot-symbol" />
        <Text style={s.word}> every </Text>
        <SlotButton
          label={PERIOD_WORD[form.period]}
          onPress={() =>
            set(
              'period',
              cycle(
                PERIOD_OPTIONS.map((o) => o.key),
                form.period,
              ),
            )
          }
          testID="slot-period"
        />
        <Text style={s.word}> until </Text>
        <SlotButton
          label={untilWords(Date.now(), form.untilDays, tzOffsetMin())}
          onPress={() => set('untilDays', cycle(UNTIL_OPTIONS, form.untilDays as (typeof UNTIL_OPTIONS)[number]))}
          testID="slot-until"
        />
        <Text style={s.word}>.</Text>
      </View>

      <View style={[s.field, check.field === 'payee' && form.payee ? s.fieldError : null]}>
        <View style={{ flex: 1 }}>
          <Label>{name ? `${name}'s wallet` : 'Payee wallet'}</Label>
          <TextInput
            testID="payee"
            style={s.fieldInput}
            value={form.payee}
            placeholder="Solana address"
            placeholderTextColor={color.ink2}
            onChangeText={(v) => set('payee', v.trim())}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>
        <Pressable
          onPress={() => {
            Clipboard.getString()
              .then((v) => set('payee', v.trim()))
              .catch(() => {})
          }}
          hitSlop={10}
        >
          <Text style={s.paste}>Paste</Text>
        </Pressable>
      </View>

      {mints.length > 1 ? (
        <Segments
          options={mints.map((m) => ({ key: m, label: m }))}
          value={symbol}
          onChange={setSymbol}
          testIDPrefix="mint"
        />
      ) : null}
      <Segments
        options={PERIOD_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
        value={form.period}
        onChange={(v) => set('period', v)}
        testIDPrefix="period"
      />
      <Segments
        options={UNTIL_OPTIONS.map((d) => ({ key: d, label: `${d} days` }))}
        value={form.untilDays}
        onChange={(v) => set('untilDays', v)}
        testIDPrefix="until"
      />

      {check.hint && (form.payee || form.amount) ? <Muted>{check.hint}</Muted> : null}
      {previewError ? <Note tone="refused">{previewError}</Note> : null}
      {preview ? <Note tone="moved">{preview.text.enforce}</Note> : null}
      {preview ? <Muted>{preview.text.schedule}</Muted> : null}
      {preview && !preview.allowed ? <Note tone="foreign">{preview.upgrade ?? 'Limit reached.'}</Note> : null}

      {grant.isSuccess ? (
        <Note tone="moved">
          Live. The chain now enforces it. The first payment to {shortAddr(form.payee)} goes out in a moment, and every
          pull sends a receipt to this phone.
        </Note>
      ) : null}
      {grant.isError ? (
        <Note tone={cancelled ? 'foreign' : 'refused'}>
          {cancelled ? 'Approval dismissed. Nothing was granted.' : `Not granted: ${grant.error.message}`}
        </Note>
      ) : null}
    </Screen>
  )
}

function SlotButton({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" testID={testID} style={s.slot}>
      <Text style={s.slotText}>{label}</Text>
    </Pressable>
  )
}

/**
 * Inline inputs cannot size to their text on every platform, so the slot is
 * sized from the text: Bricolage 800 at 30 averages about 17.5px a character.
 */
function slotWidth(text: string): number {
  return Math.min(300, Math.max(56, Math.ceil(text.length * 17.5) + 20))
}

const SENT = { fontFamily: font.display, fontSize: 30, lineHeight: 40, letterSpacing: -0.5 }

const s = StyleSheet.create({
  sentence: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 6, marginTop: 10, marginBottom: 4 },
  word: { ...SENT, color: color.ink },
  slot: { backgroundColor: color.signal50, borderRadius: radius.slot, paddingHorizontal: 8 },
  slotText: { ...SENT, color: color.signal },
  slotInput: {
    ...SENT,
    color: color.signal,
    paddingVertical: 0,
    height: 40,
    borderWidth: 0,
    // Web only: no browser focus ring around a slot.
    outlineStyle: 'none',
  } as object,
  field: {
    backgroundColor: color.card,
    borderRadius: radius.field,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fieldError: { borderWidth: 1.5, borderColor: color.refused },
  fieldInput: { fontFamily: font.medium, fontSize: 15, color: color.ink, padding: 0, marginTop: 3 },
  paste: { fontFamily: font.semibold, fontSize: 14, color: color.signal },
  note: { textAlign: 'center', fontSize: 13, lineHeight: 18 },
})
