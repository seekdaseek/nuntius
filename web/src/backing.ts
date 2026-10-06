/**
 * The web backing page, /l/<pool>: back a subscription launch from any Wallet Standard wallet
 * (Phantom, Solflare, Backpack), no APK needed. The same server flow as the app:
 *
 *   sign in with Solana (the server's single-use nonce) -> /api/mandates/back builds the grant
 *   -> core/tx-check.ts checks it against what this page shows -> the wallet signs and sends
 *   -> /api/mandates/confirm activates it only once the chain holds exactly those terms.
 *
 * A connected backer sees their permissions on this launch, each with a Revoke button.
 * On the web the page itself comes from the server, so the check guards against a builder
 * that disagrees with the page, not against a compromised server; the app pins its own.
 */
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { createSignInMessageText } from '@solana/wallet-standard-util'
import { baseUnits, checkTransaction, TxMismatch, type GrantExpect } from '../../core/tx-check'

// ---------------------------------------------------------------------------------------
// Config the server writes into the page: its executor and the tokens it offers.

interface PageConfig {
  executor: string
  cluster: 'mainnet' | 'localnet'
  mints: { symbol: string; mint: string; decimals: number; maxPerPeriodUi: string }[]
  apk: string
}
const config = JSON.parse(document.getElementById('config')!.textContent!) as PageConfig
const CLIENT = '1.1.0'
const CHAIN = config.cluster === 'mainnet' ? 'solana:mainnet' : 'solana:localnet'
const pool = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] ?? '')

// ---------------------------------------------------------------------------------------
// Small helpers.

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const b64 = {
  to: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
  from: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let s = ''
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    s = `1${s}`
  }
  return s
}
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`
const explorer = (sig: string) =>
  config.cluster === 'mainnet'
    ? `https://explorer.solana.com/tx/${sig}`
    : `https://explorer.solana.com/tx/${sig}?cluster=custom`
const store = {
  get: (k: string) => {
    try {
      return sessionStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) sessionStorage.removeItem(k)
      else sessionStorage.setItem(k, v)
    } catch {
      /* private window: the session lasts for this page only */
    }
  },
}

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
async function api<T>(path: string, body?: object): Promise<T> {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-nuntius-client': CLIENT },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string }
  if (!res.ok || !json.ok)
    throw new ApiError(json.error ?? `http_${res.status}`, json.message ?? json.error ?? `HTTP ${res.status}`)
  return json as T
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------
// The launch: live state and the feed.

interface Launch {
  pool: string
  route: 'dbc' | 'damm_v2' | 'migrating'
  baseMint: string
  quoteMint: string
  symbol: string | null
  progressPct: number
  refusal?: string | null
  committed: { backers: number; perWeek: string; symbol: string | null }
}
interface FeedPool {
  pool: string
  committedPerWeek: { all: string; thirdParty: string }
  backers: { all: number; thirdParty: number }
  buysExecuted: { all: number; thirdParty: number }
  lastBuys: { at: number; signature: string; quoteIn: string; own: boolean }[]
}
let launch: Launch | null = null
const quote = () => config.mints.find((m) => m.mint === launch?.quoteMint) ?? null

async function loadLaunch() {
  try {
    launch = (await api<{ launch: Launch }>(`/api/launch/${pool}`)).launch
  } catch (e) {
    $('state').textContent =
      e instanceof ApiError && e.code === 'launch_unsupported' ? e.message : 'This is not a launch nuntius can read.'
    $('back').hidden = true
    return
  }
  const q = quote()
  $('symbol').textContent = launch.symbol ?? short(launch.baseMint)
  $('quote').textContent = q?.symbol ?? '?'
  for (const el of document.querySelectorAll<HTMLElement>('[data-quote]')) el.textContent = q?.symbol ?? ''
  const pct = Math.max(0, Math.min(100, launch.progressPct))
  $('bar').style.width = `${pct}%`
  $('route').textContent =
    launch.route === 'dbc'
      ? `On its bonding curve, ${Math.floor(pct)}% filled`
      : launch.route === 'migrating'
        ? 'Curve filled: moving to its regular pool'
        : 'Trading in its regular pool (Meteora DAMM v2)'
  $('committed').textContent =
    launch.committed.backers === 0
      ? 'No backers yet. Be the first.'
      : `${launch.committed.backers} ${launch.committed.backers === 1 ? 'backer commits' : 'backers commit'} ${launch.committed.perWeek} ${launch.committed.symbol ?? ''} a week`
  if (launch.refusal || !q || launch.route === 'migrating') {
    $('state').textContent =
      launch.refusal ??
      (!q
        ? 'This launch is priced in a token nuntius does not pull.'
        : 'Backing opens again once the token is in its regular pool.')
    $('back').hidden = true
  }
  sentence()
  try {
    const feed = await api<{ launches: FeedPool[] }>('/api/launches')
    const f = feed.launches.find((x) => x.pool === pool)
    if (f) {
      $('buys').textContent = `${f.buysExecuted.all} ${f.buysExecuted.all === 1 ? 'buy' : 'buys'} executed`
      const list = $('recent')
      list.replaceChildren(
        ...f.lastBuys.slice(0, 5).map((b) => {
          const li = document.createElement('li')
          const a = document.createElement('a')
          a.href = explorer(b.signature)
          a.target = '_blank'
          a.rel = 'noopener'
          a.textContent = `${b.quoteIn} ${q?.symbol ?? ''} · ${new Date(b.at).toUTCString().slice(5, 22)} UTC`
          li.append(a)
          if (b.own) li.append(' (the builder’s own)')
          return li
        }),
      )
    }
  } catch {
    /* the numbers above stand without the feed */
  }
}

// ---------------------------------------------------------------------------------------
// The form.

const PERIODS: Record<string, { s: number; words: string }> = {
  day: { s: 86_400, words: 'every day' },
  week: { s: 604_800, words: 'every week' },
}
const form = { amount: '', period: 'week', untilDays: 90 }
function sentence() {
  const sym = launch?.symbol ?? 'this launch'
  $('sentence').textContent =
    `Back ${sym}: ${form.amount || '…'} ${quote()?.symbol ?? ''} ${PERIODS[form.period]!.words}, for ${form.untilDays} days.`
  const q = quote()
  const ok =
    !!q &&
    baseUnits(form.amount, q.decimals) !== null &&
    Number(form.amount) > 0 &&
    Number(form.amount) <= Number(q.maxPerPeriodUi)
  $('hint').textContent =
    q && form.amount && Number(form.amount) > Number(q.maxPerPeriodUi)
      ? `At most ${q.maxPerPeriodUi} ${q.symbol} each period for now.`
      : ''
  $<HTMLButtonElement>('approve').disabled = !ok || busy
}
function bindSegments(id: string, key: 'period' | 'untilDays') {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => {
      ;(form as Record<string, unknown>)[key] = key === 'untilDays' ? Number(b.dataset.v) : b.dataset.v
      for (const x of $(id).querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b))
      sentence()
    })
  }
}

// ---------------------------------------------------------------------------------------
// The wallet: Wallet Standard discovery, sign-in, sign and send.

let wallet: Wallet | null = null
let account: WalletAccount | null = null
let session = store.get('nuntius-session')
let busy = false

function walletsThatFit(): Wallet[] {
  return getWallets()
    .get()
    .filter(
      (w) =>
        w.chains.some((c) => c.startsWith('solana:')) &&
        'solana:signAndSendTransaction' in w.features &&
        'standard:connect' in w.features,
    )
}
function showWallets() {
  const list = $('wallets')
  const found = walletsThatFit()
  list.replaceChildren(
    ...found.map((w) => {
      const b = document.createElement('button')
      b.className = 'wallet'
      const img = document.createElement('img')
      img.src = w.icon
      img.alt = ''
      b.append(img, w.name)
      b.addEventListener('click', () => void connect(w))
      return b
    }),
  )
  $('nowallet').hidden = found.length > 0
}

type Feature<T> = Record<string, T>
async function connect(w: Wallet) {
  status('Connecting…')
  try {
    const { accounts } = await (w.features as Feature<{ connect: () => Promise<{ accounts: WalletAccount[] }> }>)[
      'standard:connect'
    ]!.connect()
    if (!accounts[0]) throw new Error('the wallet shared no account')
    wallet = w
    account = accounts[0]
    $('connected').textContent = `${w.name} · ${short(account.address)}`
    $('step-wallet').hidden = true
    $('step-back').hidden = false
    if (store.get('nuntius-session-wallet') !== account.address) session = null
    status('')
    await refreshMine()
  } catch (e) {
    status(errorWords(e), true)
  }
}

/** Sign in with Solana: the server's payload, signed as the app signs it, verified by the server. */
async function signIn(): Promise<string> {
  if (session) return session
  const { payload } = await api<{
    payload: { domain: string; uri: string; statement: string; nonce: string; issuedAt: string; expirationTime: string }
  }>('/api/siws-payload')
  let signedMessage: Uint8Array
  let signature: Uint8Array
  let publicKey: Uint8Array
  const f = wallet!.features as Feature<{
    signIn?: (...i: object[]) => Promise<{ account: WalletAccount; signedMessage: Uint8Array; signature: Uint8Array }[]>
    signMessage?: (...i: object[]) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>
  }>
  if (f['solana:signIn']?.signIn) {
    const [out] = await f['solana:signIn'].signIn({ ...payload, address: account!.address })
    signedMessage = out!.signedMessage
    signature = out!.signature
    publicKey = new Uint8Array(out!.account.publicKey)
  } else if (f['solana:signMessage']?.signMessage) {
    // The same text the wallet's own sign-in would show; the server verifies it either way.
    const message = new TextEncoder().encode(createSignInMessageText({ ...payload, address: account!.address }))
    const [out] = await f['solana:signMessage'].signMessage({ account: account!, message })
    signedMessage = out!.signedMessage
    signature = out!.signature
    publicKey = new Uint8Array(account!.publicKey)
  } else throw new Error('This wallet cannot sign in with Solana.')
  const r = await api<{ session: string; address: string }>('/api/siws-verify', {
    nonce: payload.nonce,
    signInResult: { address: b64.to(publicKey), signed_message: b64.to(signedMessage), signature: b64.to(signature) },
  })
  if (r.address !== account!.address) throw new Error('The wallet signed in with another account.')
  session = r.session
  store.set('nuntius-session', session)
  store.set('nuntius-session-wallet', account!.address)
  return session
}

/** Checks the server's transaction, then the wallet signs and sends it. Returns the signature. */
async function signAndSend(base64: string, check: (b: string) => Promise<void>): Promise<string> {
  await check(base64)
  const f = wallet!.features as Feature<{
    signAndSendTransaction: (...i: object[]) => Promise<{ signature: Uint8Array }[]>
  }>
  const [out] = await f['solana:signAndSendTransaction']!.signAndSendTransaction({
    account: account!,
    transaction: b64.from(base64),
    chain: CHAIN,
  })
  return base58(out!.signature)
}

async function untilLanded<T>(call: () => Promise<T>, waitOn: string[], tries = 30): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await call()
    } catch (e) {
      if (!(e instanceof ApiError) || !waitOn.includes(e.code) || i >= tries) throw e
      await sleep(2_000)
    }
  }
}

// ---------------------------------------------------------------------------------------
// Back, and revoke.

async function back() {
  const q = quote()
  if (!q || !launch || !account) return
  busy = true
  sentence()
  let mandateId: string | null = null
  try {
    status('Sign in with your wallet…')
    const s = await signIn()
    // What the transaction must say, from this page alone, before the server is asked.
    const expect: GrantExpect = {
      kind: 'grant',
      wallet: account.address,
      mint: q.mint,
      decimals: q.decimals,
      delegatee: config.executor,
      amountPerPeriod: baseUnits(form.amount, q.decimals)!,
      periodLengthS: PERIODS[form.period]!.s,
      untilDays: form.untilDays,
      nowS: Math.floor(Date.now() / 1000),
      shownAllowance: undefined,
      baseMint: launch.baseMint,
    }
    status('Building the permission…')
    const built = await api<{ mandateId: string; transactionBase64: string }>('/api/mandates/back', {
      session: s,
      pool,
      symbol: q.symbol,
      amount: form.amount,
      period: form.period,
      untilDays: form.untilDays,
      label: `Back ${launch.symbol ?? 'launch'}`.slice(0, 40),
    })
    mandateId = built.mandateId
    status(`Approve in ${wallet!.name}…`)
    let signature: string | null = null
    try {
      signature = await signAndSend(built.transactionBase64, (b) => checkTransaction(b, expect))
    } catch (e) {
      if (e instanceof TxMismatch) throw e
      // A wallet can report an error after sending: ask the chain, through the server, before saying no.
      const landed = await api<{ mandate: unknown }>('/api/mandates/confirm', { session: s, mandateId }).catch(
        () => null,
      )
      if (!landed) throw e
    }
    status('Waiting for the chain…')
    await untilLanded(() => api('/api/mandates/confirm', { session: s, mandateId }), ['not_on_chain_yet'])
    status(
      `Live. ${form.amount} ${q.symbol} ${PERIODS[form.period]!.words} buys ${launch.symbol ?? 'the token'} into your wallet. The first buy comes within about 10 minutes.`,
      false,
      signature ? explorer(signature) : undefined,
    )
    await refreshMine()
    await loadLaunch()
  } catch (e) {
    status(errorWords(e), true)
  } finally {
    busy = false
    sentence()
  }
}

interface MineRow {
  delegationPda: string
  label: string
  cap: string
  symbol: string
  mint: string
  periodLengthS: number
  back: { pool: string; received: string; baseSymbol: string } | null
}
async function refreshMine() {
  const box = $('mine')
  if (!session || !account) {
    box.hidden = true
    return
  }
  try {
    const l = await api<{ mine: MineRow[]; tokenAccounts: { symbol: string; allowance: string | null }[] }>(
      '/api/mandates/list',
      {
        session,
      },
    )
    const rows = l.mine.filter((m) => m.back?.pool === pool)
    box.hidden = rows.length === 0
    $('mine-list').replaceChildren(
      ...rows.map((m) => {
        const li = document.createElement('li')
        const words = document.createElement('span')
        words.textContent = `${m.cap} ${m.symbol} ${m.periodLengthS === 86_400 ? 'a day' : m.periodLengthS === 604_800 ? 'a week' : `every ${m.periodLengthS} s`} · received ${m.back!.received} ${m.back!.baseSymbol}`
        const b = document.createElement('button')
        b.className = 'revoke'
        b.textContent = 'Revoke'
        b.addEventListener(
          'click',
          () => void revoke(m, l.tokenAccounts.find((t) => t.symbol === m.symbol)?.allowance ?? null),
        )
        li.append(words, b)
        return li
      }),
    )
  } catch (e) {
    if (e instanceof ApiError && e.code === 'session_invalid') {
      session = null
      store.set('nuntius-session', null)
    }
    box.hidden = true
  }
}

async function revoke(m: MineRow, allowance: string | null) {
  const q = config.mints.find((x) => x.mint === m.mint)
  try {
    status(`Approve the revoke in ${wallet!.name}…`)
    const s = await signIn()
    const r = await api<{ transactionBase64: string }>('/api/mandates/revoke', {
      session: s,
      delegationPda: m.delegationPda,
    })
    await signAndSend(r.transactionBase64, (b) =>
      checkTransaction(b, {
        kind: 'revoke',
        wallet: account!.address,
        delegationPda: m.delegationPda,
        mint: m.mint,
        allowance: allowance && q ? baseUnits(allowance, q.decimals) : undefined,
      }),
    )
    status('Waiting for the chain…')
    await untilLanded(
      () => api('/api/mandates/revoke-confirm', { session: s, delegationPda: m.delegationPda }),
      ['still_live'],
    )
    status('Revoked. Nothing more will be taken.')
    await refreshMine()
    await loadLaunch()
  } catch (e) {
    status(errorWords(e), true)
  }
}

// ---------------------------------------------------------------------------------------

function errorWords(e: unknown): string {
  if (e instanceof TxMismatch) return e.message
  const m = e instanceof Error ? e.message : String(e)
  if (/reject|denied|cancel/i.test(m)) return 'Cancelled in the wallet. Nothing was sent.'
  return m
}
function status(text: string, bad = false, link?: string) {
  const el = $('status')
  el.className = bad ? 'status bad' : 'status'
  el.textContent = text
  if (link) {
    const a = document.createElement('a')
    a.href = link
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = ' See it on Explorer.'
    el.append(a)
  }
}

$<HTMLAnchorElement>('apk').href = config.apk
$('pool').textContent = short(pool)
$<HTMLInputElement>('amount').addEventListener('input', (e) => {
  form.amount = (e.target as HTMLInputElement).value.replace(',', '.').replace(/[^0-9.]/g, '')
  ;(e.target as HTMLInputElement).value = form.amount
  sentence()
})
bindSegments('periods', 'period')
bindSegments('durations', 'untilDays')
$('approve').addEventListener('click', () => void back())
getWallets().on('register', showWallets)
showWallets()
void loadLaunch()
