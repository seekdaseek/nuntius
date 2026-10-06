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
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  registerMwa,
  SolanaMobileWalletAdapterWalletName,
} from '@solana-mobile/wallet-standard-mobile'
import { baseUnits, checkTransaction, TxMismatch, type GrantExpect } from '../../core/tx-check'

// ---------------------------------------------------------------------------------------
// Config the server writes into the page: its executor and the tokens it offers.

interface PageConfig {
  executor: string
  cluster: 'mainnet' | 'localnet'
  mints: { symbol: string; mint: string; decimals: number; maxPerPeriodUi: string }[]
  apk: string
  /** What a first back grant costs its signer in rent and base fee, lamports; null: unknown. */
  setupLamports?: string | null
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
  /** The token's image from its metadata: a path on this origin or an https URL. */
  image?: string | null
  progressPct: number
  /** The token's promises, read from its mint and metadata accounts on this request; null: not read. */
  trust?: {
    mint: string
    metadata: string | null
    mintAuthorityDisabled: boolean | null
    freezeAuthorityDisabled: boolean | null
    metadataPermanent: boolean | null
    supply?: string | null
    decimals?: number | null
  } | null
  /** Quote raised on the curve and the threshold that completes it, in base units. */
  quoteRaised?: string
  threshold?: string
  refusal?: string | null
  committed: { backers: number; perWeek: string; symbol: string | null }
  /** Whose money it is, in the server's one sentence (the link card says the same). */
  commitment?: { card: string; line: string }
  /** Price in the quote token, the quote token's USD price, market cap in the quote token; null: not read. */
  market?: { priceQuote: number | null; quoteUsd: number | null; marketCapQuote: number | null }
  /** The curve's price path: last token over first, and where the price is now on that scale. */
  curve?: { priceRatio: number; nowRatio: number | null } | null
}
interface FeedPool {
  pool: string
  committedPerWeek: { all: string; thirdParty: string }
  backers: { all: number; thirdParty: number }
  buysExecuted: { all: number; thirdParty: number }
  commitment?: { card: string; line: string }
  lastBuys: { at: number; signature: string; quoteIn: string; baseOut: string | null; own: boolean; backer?: string }[]
  nextBuys?: { at: number; quoteIn: string; own: boolean; backer: string }[]
}
let launch: Launch | null = null
let feed: FeedPool | null = null
const quote = () => config.mints.find((m) => m.mint === launch?.quoteMint) ?? null
const symbolOf = () => launch?.symbol ?? 'this launch'

/** Numbers as a person reads them: grouped, a sensible number of digits, tiny prices in full. */
function num(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—'
  if (n !== 0 && Math.abs(n) < 0.01) return n.toLocaleString('en-US', { maximumSignificantDigits: 3 })
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}
const usd = (n: number | null) => (n === null ? '' : `≈ $${num(n, n < 1 ? 6 : 2)}`)
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}
function countdown(ms: number): string {
  const s = Math.round((ms - Date.now()) / 1000)
  if (s <= 60) return 'due now'
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d > 0 ? `in ${d} d ${h} h` : h > 0 ? `in ${h} h ${m} m` : `in ${m} m`
}

async function loadLaunch() {
  try {
    launch = (await api<{ launch: Launch }>(`/api/launch/${pool}`)).launch
  } catch (e) {
    $('state').textContent =
      e instanceof ApiError && e.code === 'launch_unsupported' ? e.message : 'This is not a launch nuntius can read.'
    $('back').hidden = true
    $('mbar').hidden = true
    return
  }
  const q = quote()
  $('symbol').textContent = launch.symbol ?? short(launch.baseMint)
  document.querySelectorAll<HTMLElement>('[data-symbol]').forEach((el) => (el.textContent = symbolOf()))
  showLogo(launch.image ?? null)
  showTrust(launch.trust ?? null)
  const mint = $<HTMLButtonElement>('copymint')
  mint.textContent = `${short(launch.baseMint)} ⧉`
  mint.hidden = false
  const routePill = $('routepill')
  routePill.textContent =
    launch.route === 'dbc' ? 'On its bonding curve' : launch.route === 'migrating' ? 'Graduating' : 'On DAMM v2'
  routePill.hidden = false
  // A day's amount to start with, as the link card says: 1 USDC or 5 of anything else, or this
  // token's ceiling when that is lower.
  if (!amountTouched && q) {
    form.amount = q.symbol === 'USDC' ? '1' : '5'
    if (Number(form.amount) > Number(q.maxPerPeriodUi)) form.amount = q.maxPerPeriodUi
    $<HTMLInputElement>('amount').value = form.amount
  }
  $('quote').textContent =
    q && launch.quoteRaised !== undefined
      ? `${num(Number(BigInt(launch.quoteRaised)) / 10 ** q.decimals)} ${q.symbol} raised`
      : ''
  document.querySelectorAll<HTMLElement>('[data-quote]').forEach((el) => (el.textContent = q?.symbol ?? ''))
  const pct = Math.max(0, Math.min(100, launch.progressPct))
  $('bar').style.width = `${pct}%`
  $('curvePct').textContent = launch.route === 'dbc' ? `${num(pct)}%` : 'graduated'
  $('route').textContent =
    launch.route === 'dbc'
      ? curveWords(launch, q)
      : launch.route === 'migrating'
        ? 'Curve filled: moving to its regular pool'
        : 'Trading in its regular pool (Meteora DAMM v2)'
  if (q && launch.threshold)
    $('graduation').textContent =
      `Graduates to DAMM v2 at ${num(Number(BigInt(launch.threshold)) / 10 ** q.decimals)} ${q.symbol}`
  drawCurve(launch.curve ?? null, pct)
  // Market numbers, after the ones only nuntius has.
  const m = launch.market
  if (m && q) {
    $('price').textContent = m.priceQuote === null ? '—' : `${num(m.priceQuote)} ${q.symbol}`
    $('priceUsd').textContent = m.priceQuote === null ? '' : usd(m.quoteUsd === null ? null : m.priceQuote * m.quoteUsd)
    $('mcap').textContent = m.marketCapQuote === null ? '—' : `${num(m.marketCapQuote, 0)} ${q.symbol}`
    $('mcapUsd').textContent =
      m.marketCapQuote === null ? '' : usd(m.quoteUsd === null ? null : m.marketCapQuote * m.quoteUsd)
  }
  $('committed').textContent = launch.commitment?.line ?? ''
  $('committedWeek').textContent = `${launch.committed.perWeek} ${launch.committed.symbol ?? q?.symbol ?? ''}`
  $('backers').textContent = String(launch.committed.backers)
  if (launch.refusal || !q || launch.route === 'migrating') {
    $('state').textContent =
      launch.refusal ??
      (!q
        ? 'This launch is priced in a token nuntius does not pull.'
        : 'Backing opens again once the token is in its regular pool.')
    $('back').hidden = true
    $('mbar').hidden = true
  }
  sentence()
  try {
    const all = await api<{ launches: FeedPool[] }>('/api/launches')
    feed = all.launches.find((x) => x.pool === pool) ?? null
  } catch {
    feed = null /* the numbers above stand without the feed */
  }
  showFeed()
}

/** Committed backers, the next buys with a countdown, and every buy with its backer and tag. */
function showFeed() {
  const q = quote()
  const sym = launch?.symbol ?? ''
  const f = feed
  // The feed refreshes it; without the feed the launch's own sentence stands.
  if (f?.commitment) $('committed').textContent = f.commitment.line
  const third = f?.backers.thirdParty ?? 0
  const all = f?.backers.all ?? launch?.committed.backers ?? 0
  $('backersNote').textContent =
    all === 0 ? 'nobody yet' : third === 0 ? "all the builder's own" : `${third} from other wallets`
  // Only from the feed's own count of outside backers, and only while the page takes backing.
  $('beFirst').hidden = !(f && f.backers.thirdParty === 0 && !$('back').hidden)
  const next = f?.nextBuys ?? []
  $('nextBuy').textContent = next[0] ? countdown(next[0].at) : '—'
  $('nextBuyNote').textContent = next[0]
    ? `${next[0].quoteIn} ${q?.symbol ?? ''} · ${short(next[0].backer)}`
    : 'once someone backs it'
  $('buys').textContent = f
    ? `${f.buysExecuted.all} ${f.buysExecuted.all === 1 ? 'buy' : 'buys'} executed`
    : 'No buys yet'
  const tag = (own: boolean) => {
    const t = document.createElement('span')
    t.className = own ? 'tag own' : 'tag backer'
    t.textContent = own ? 'builder’s own' : 'backer'
    return t
  }
  const row = (when: string, what: (string | Node)[], who: string | undefined, own: boolean, link?: string) => {
    const li = document.createElement('li')
    const w = document.createElement('span')
    w.className = 'when'
    w.textContent = when
    const x = document.createElement('span')
    x.className = 'what'
    x.append(...what, tag(own))
    const b = document.createElement('span')
    b.className = 'who'
    b.textContent = who ? short(who) : ''
    li.append(w, x, b)
    if (link) {
      const a = document.createElement('a')
      a.className = 'tx'
      a.href = link
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = '↗'
      a.title = 'See it on Explorer'
      li.append(a)
    }
    return li
  }
  const bold = (t: string) => {
    const e = document.createElement('b')
    e.textContent = t
    return e
  }
  const baseDec = launch?.trust?.decimals ?? 6
  $('upcoming').replaceChildren(
    ...next
      .slice(0, 3)
      .map((n) =>
        row(countdown(n.at), ['Buys ', bold(`${n.quoteIn} ${q?.symbol ?? ''}`), ' of ', sym], n.backer, n.own),
      ),
  )
  $('recent').replaceChildren(
    ...(f?.lastBuys ?? [])
      .slice(0, 8)
      .map((b) =>
        row(
          ago(b.at),
          b.baseOut
            ? [
                'Bought ',
                bold(`${num(Number(BigInt(b.baseOut)) / 10 ** baseDec, 0)} ${sym}`),
                ` for ${b.quoteIn} ${q?.symbol ?? ''}`,
              ]
            : ['Bought for ', bold(`${b.quoteIn} ${q?.symbol ?? ''}`)],
          b.backer,
          b.own,
          explorer(b.signature),
        ),
      ),
  )
}

/** The curve's price path, √price rising evenly with what is raised, from ×1 to ×priceRatio, with "now". */
function drawCurve(c: Launch['curve'] | null, pct: number) {
  const svg = $('curveSvg')
  // An SVG element has no hidden property: the attribute itself is what hides it.
  if (!c || !(c.priceRatio > 1)) {
    svg.setAttribute('hidden', '')
    $('curveLegend').hidden = true
    return
  }
  const W = 900
  const top = 16
  const bottom = 176
  const k = Math.sqrt(c.priceRatio) - 1
  const y = (x: number) => bottom - (((1 + k * x) ** 2 - 1) / (c.priceRatio - 1)) * (bottom - top)
  const pts = Array.from({ length: 41 }, (_, i) => [8 + (i / 40) * (W - 16), y(i / 40)] as const)
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join(' ')
  $('curveLine').setAttribute('d', line)
  $('curveFill').setAttribute('d', `${line} L${W - 8} ${bottom} L8 ${bottom} Z`)
  const nx = 8 + (Math.max(0, Math.min(100, pct)) / 100) * (W - 16)
  const ny = y(pct / 100)
  const set = (id: string, a: Record<string, string | number>) => {
    for (const [n, v] of Object.entries(a)) $(id).setAttribute(n, String(v))
  }
  set('nowLine', { x1: nx, x2: nx, y1: ny, y2: bottom })
  set('nowDot', { cx: nx, cy: ny })
  $('endText').replaceChildren(
    'last token ',
    Object.assign(document.createElement('b'), { textContent: `×${num(c.priceRatio, 1)}` }),
  )
  svg.removeAttribute('hidden')
  $('curveLegend').hidden = false
  $('nowLegend').replaceChildren(
    'now ',
    Object.assign(document.createElement('b'), { textContent: `×${num(c.nowRatio ?? 1, 2)}` }),
  )
}

/** "On its bonding curve: 24.75 of 50,000 SKR raised": a percentage reads as nothing at the start. */
function curveWords(l: Launch, q: PageConfig['mints'][number] | null): string {
  if (!q || l.quoteRaised === undefined || l.threshold === undefined)
    return `On its bonding curve, ${Math.floor(l.progressPct)}% filled`
  const ui = (base: string) =>
    (Number(BigInt(base)) / 10 ** q.decimals).toLocaleString('en-US', { maximumFractionDigits: 2 })
  return `On its bonding curve: ${ui(l.quoteRaised)} of ${ui(l.threshold)} ${q.symbol} raised`
}

/** An account on Solscan (mainnet) or on the explorer pointed at this validator. */
const accountUrl = (address: string, token: boolean) =>
  config.cluster === 'mainnet'
    ? `https://solscan.io/${token ? 'token' : 'account'}/${address}`
    : `https://explorer.solana.com/address/${address}?cluster=custom`

/**
 * A badge for each promise the chain confirmed on this load, linked to the account that holds
 * it. A fact that was not read (null) or does not hold (false) shows nothing: no guesses.
 */
function showTrust(t: Launch['trust'] | null) {
  const list = $('trust')
  const badges: [string, string][] = []
  if (t?.mintAuthorityDisabled === true) badges.push(['Mint authority disabled', accountUrl(t.mint, true)])
  if (t?.freezeAuthorityDisabled === true) badges.push(['Freeze authority disabled', accountUrl(t.mint, true)])
  if (t?.metadataPermanent === true && t.metadata)
    badges.push(['On-chain metadata permanent', accountUrl(t.metadata, false)])
  list.replaceChildren(
    ...badges.map(([words, href]) => {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener'
      a.textContent = words
      li.append(a)
      return li
    }),
  )
  list.hidden = badges.length === 0
}

/** The token's own image beside its name; shown once it has loaded, never a broken icon. */
function showLogo(src: string | null) {
  const img = $<HTMLImageElement>('logo')
  if (!src || !(src.startsWith('/') || src.startsWith('https://'))) return void (img.hidden = true)
  if (img.getAttribute('src') === src) return
  img.onload = () => (img.hidden = false)
  img.onerror = () => (img.hidden = true)
  img.referrerPolicy = 'no-referrer'
  img.src = src
}

// ---------------------------------------------------------------------------------------
// The form.

const PERIODS: Record<string, { s: number; words: string }> = {
  day: { s: 86_400, words: 'every day' },
  week: { s: 604_800, words: 'every week' },
}
const form = { amount: '5', period: 'day', untilDays: 30 }
let amountTouched = false
function sentence() {
  const q = quote()
  // "5 SKR a day for 30 days · at most 150 SKR in total · nothing is deposited". The total is the
  // grant's own lifetime cap: the amount times the periods that start before the expiry
  // (server/src/allowance.ts newGrantLifetime), what Seed Vault shows for this permission.
  const per = PERIODS[form.period]!
  const periods = Math.ceil((form.untilDays * 86_400) / per.s)
  const amt = Number(form.amount)
  const unit = q?.symbol ?? ''
  const total = Number.isFinite(amt) && amt > 0 ? num(amt * periods, 6) : '…'
  const summary = document.createElement('b')
  summary.textContent = `${form.amount || '…'} ${unit} a ${form.period} for ${form.untilDays} days`
  $('sentence').replaceChildren(summary, ` · at most ${total} ${unit} in total · nothing is deposited`)
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
  // No SKR, no backing: say so before anyone signs, with where to get it.
  const need = q && ok && quoteBalance !== null && quoteBalance < baseUnits(form.amount, q.decimals)!
  const note = $('needquote')
  note.hidden = !need
  if (need && q) {
    const a = document.createElement('a')
    a.href = `https://jup.ag/swap?sell=So11111111111111111111111111111111111111112&buy=${q.mint}`
    a.target = '_blank'
    a.rel = 'noopener'
    a.textContent = `Get ${q.symbol} on Jupiter`
    note.replaceChildren(`You need ${q.symbol} to back ${launch?.symbol ?? 'this launch'}. `, a)
  }
  const setup = config.setupLamports ? Number(config.setupLamports) / 1e9 : null
  $('setup').hidden = setup === null
  if (setup !== null)
    $('setup').textContent =
      `The first approval also pays up to about ${setup.toFixed(4)} SOL for setup: rent for the permission's accounts and your ${launch?.symbol ?? 'token'} account, plus your wallet's network fee.`
}
function bindSegments(id: string, key: 'period' | 'untilDays') {
  // NodeList.forEach, not for...of: the repository's TypeScript lib has no DOM iterators.
  $(id)
    .querySelectorAll<HTMLButtonElement>('button')
    .forEach((b) => {
      b.addEventListener('click', () => {
        ;(form as Record<string, unknown>)[key] = key === 'untilDays' ? Number(b.dataset.v) : b.dataset.v
        $(id)
          .querySelectorAll('button')
          .forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
        sentence()
      })
    })
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
const PHONE_WALLET = 'Wallet app on this phone'
/** How the page names a wallet in its own sentences. */
const walletName = (w: Wallet, inSentence = false) =>
  w.name !== SolanaMobileWalletAdapterWalletName ? w.name : inSentence ? 'your wallet app' : PHONE_WALLET
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
      const name = document.createElement('span')
      if (w.name === SolanaMobileWalletAdapterWalletName) {
        // MWA is how Chrome on Android reaches the phone's own wallet apps: name what it opens.
        const app = document.createElement('b')
        app.textContent = PHONE_WALLET
        const which = document.createElement('small')
        which.textContent = 'Seed Vault, Phantom, Solflare'
        name.append(app, which)
      } else name.textContent = w.name
      b.append(img, name)
      b.addEventListener('click', () => void connect(w))
      return b
    }),
  )
  $('nowallet').hidden = found.length > 0
  // Phones inject no wallet into their browser (and iOS has no Mobile Wallet Adapter): open
  // this same page inside a wallet's own browser instead. Shown only when none registered.
  if (found.length === 0) {
    const url = encodeURIComponent(location.href)
    const ref = encodeURIComponent('https://nuntius.ochinimus.app')
    $('openin').replaceChildren(
      ...[
        ['Open in Phantom', `https://phantom.com/ul/browse/${url}?ref=${ref}`],
        ['Open in Solflare', `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`],
        ['Open in Backpack', `https://backpack.app/ul/v1/browse/${url}?ref=${ref}`],
      ].map(([words, href]) => {
        const a = document.createElement('a')
        a.href = href!
        a.rel = 'noopener'
        a.textContent = words!
        return a
      }),
    )
  }
}

/** The connected wallet's balance of the launch's quote token, base units; null until read. */
let quoteBalance: bigint | null = null
async function refreshBalance() {
  const q = quote()
  if (!account || !q) return
  try {
    const r = await api<{ amount: string }>(`/api/balance/${account.address}/${q.mint}`)
    quoteBalance = BigInt(r.amount)
  } catch {
    quoteBalance = null
  }
  sentence()
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
    $('connected').textContent = `${walletName(w)} · ${short(account.address)}`
    $('step-wallet').hidden = true
    $('step-back').hidden = false
    if (store.get('nuntius-session-wallet') !== account.address) session = null
    approveLabel()
    status('')
    void refreshBalance()
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
    // MWA answers solana:signIn from the authorization it cached at connect, which has no
    // sign-in result (6 Oct, Seed Vault from Chrome). Forgetting that authorization first
    // (local, no trip to the wallet) makes it authorize afresh with the sign-in payload: the
    // way the app signs in with Seed Vault. Signing the text as a message did not verify.
    if (wallet!.name === SolanaMobileWalletAdapterWalletName)
      await (wallet!.features as Feature<{ disconnect?: () => Promise<void> }>)['standard:disconnect']?.disconnect?.()
    const [out] = await f['solana:signIn'].signIn({ ...payload, address: account!.address })
    signedMessage = out!.signedMessage
    signature = out!.signature
    publicKey = new Uint8Array(out!.account.publicKey)
  } else if (f['solana:signMessage']?.signMessage) {
    // The same text the wallet's own sign-in would show; the server verifies it either way.
    const message = new TextEncoder().encode(createSignInMessageText({ ...payload, address: account!.address }))
    const [out] = await f['solana:signMessage'].signMessage({ account: account!, message })
    // A wallet may return the signed payload, the message with its signature appended, as
    // signedMessage; the message is what the server must verify.
    const sm = out!.signedMessage
    const appended =
      sm.length === message.length + 64 &&
      message.every((b, i) => sm[i] === b) &&
      out!.signature.every((b, i) => sm[message.length + i] === b)
    signedMessage = appended ? message : sm
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

/** A permission built but not yet approved: the same terms rebuild it instead of making another. */
let pending: { id: string; key: string } | null = null
const isMwa = () => wallet?.name === SolanaMobileWalletAdapterWalletName

/**
 * With MWA every trip to the wallet must start from a tap: Chrome opens the wallet only within
 * a tap's activation, and a sign-in trip followed by a build in the same tap left none for the
 * approval (6 Oct, the Seeker: "no installed wallet"). So with MWA, signing in is its own tap.
 */
function approveLabel() {
  $('approve').textContent = session ? 'Approve in your wallet' : isMwa() ? 'Sign in' : 'Sign in and approve'
}

async function back() {
  const q = quote()
  if (!q || !launch || !account) return
  busy = true
  sentence()
  let mandateId: string | null = null
  try {
    if (!session && isMwa()) {
      status('Sign in with your wallet…')
      await signIn()
      approveLabel()
      status('Signed in. Tap “Approve in your wallet” to approve the permission.')
      // Signed in now: show what this wallet already granted here, so a revoke is one tap away
      // (6 Oct: the list stayed hidden until the page was reloaded).
      await refreshMine()
      return
    }
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
    const key = [account.address, pool, form.amount, form.period, form.untilDays].join('|')
    let built: { mandateId: string; transactionBase64: string } | null = null
    let landedEarlier = false
    if (pending?.key === key) {
      try {
        built = {
          mandateId: pending.id,
          ...(await api<{ transactionBase64: string }>('/api/mandates/rebuild', { session: s, mandateId: pending.id })),
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'already_on_chain') landedEarlier = true
        else if (!(e instanceof ApiError && (e.code === 'no_mandate' || e.code === 'not_pending'))) throw e
        if (!landedEarlier) pending = null
      }
    }
    if (landedEarlier) mandateId = pending!.id
    else {
      built ??= await api<{ mandateId: string; transactionBase64: string }>('/api/mandates/back', {
        session: s,
        pool,
        symbol: q.symbol,
        amount: form.amount,
        period: form.period,
        untilDays: form.untilDays,
        label: `Back ${launch.symbol ?? 'launch'}`.slice(0, 40),
      })
      mandateId = built.mandateId
      pending = { id: built.mandateId, key }
    }
    status(`Approve in ${walletName(wallet!, true)}…`)
    let signature: string | null = null
    if (built && !landedEarlier)
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
    pending = null
    // The list first, then the word: "Live" never shows beside a list that lacks it.
    await refreshMine()
    status(
      `Live. ${form.amount} ${q.symbol} ${PERIODS[form.period]!.words} buys ${launch.symbol ?? 'the token'} into your wallet. The first buy comes within about 10 minutes.`,
      false,
      signature ? explorer(signature) : undefined,
    )
    shareOffer(q.symbol)
    await loadLaunch()
  } catch (e) {
    status(errorWords(e), true)
  } finally {
    busy = false
    sentence()
  }
}

/** After a grant: the visitor may post it themselves. nuntius never posts for anyone. */
function shareOffer(quoteSymbol: string) {
  const text = `I back $${launch?.symbol ?? 'this launch'} with ${form.amount} ${quoteSymbol} a ${form.period}: a capped buy straight into my own wallet, nothing deposited, revoke any time.`
  const a = document.createElement('a')
  a.href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.href)}`
  a.target = '_blank'
  a.rel = 'noopener'
  a.textContent = 'Share on X'
  $('share').replaceChildren(a)
  $('share').hidden = false
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
    status(`Approve the revoke in ${walletName(wallet!, true)}…`)
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
    await refreshMine()
    status('Revoked. Nothing more will be taken.')
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
$<HTMLInputElement>('amount').value = form.amount
$<HTMLInputElement>('amount').addEventListener('input', (e) => {
  amountTouched = true
  form.amount = (e.target as HTMLInputElement).value.replace(',', '.').replace(/[^0-9.]/g, '')
  ;(e.target as HTMLInputElement).value = form.amount
  sentence()
})
bindSegments('periods', 'period')
bindSegments('durations', 'untilDays')
sentence()
$('approve').addEventListener('click', () => void back())
// The token's mint, copied in one tap.
$('copymint').addEventListener('click', () => {
  if (launch) void navigator.clipboard?.writeText(launch.baseMint).then(() => ($('copymint').textContent = 'copied ✓'))
})
// On a phone the panel is a sheet that a fixed button opens; on a desktop it is always in view.
const sheet = (open: boolean) => document.body.classList.toggle('sheet-open', open)
$('openSheet').addEventListener('click', () => sheet(true))
$('closeSheet').addEventListener('click', () => sheet(false))
$('scrim').addEventListener('click', () => sheet(false))
$('beFirst').addEventListener('click', () => {
  if (matchMedia('(max-width: 960px)').matches) sheet(true)
  else $('amount').focus()
})
// The countdowns move on their own.
setInterval(() => {
  if (feed) showFeed()
}, 20_000)
// Back to the wallet list. The wallet forgets this site (MWA clears its cached authorization),
// so the next connection can pick another account.
$('switch').addEventListener('click', () => {
  const w = wallet
  wallet = null
  account = null
  session = null
  store.set('nuntius-session', null)
  store.set('nuntius-session-wallet', null)
  $('step-back').hidden = true
  $('step-wallet').hidden = false
  $('mine').hidden = true
  pending = null
  quoteBalance = null
  sentence()
  status('')
  const disconnect = (w?.features as Feature<{ disconnect: () => Promise<void> }> | undefined)?.['standard:disconnect']
  void disconnect?.disconnect().catch(() => {})
})
// Chrome on Android has no injected wallet: the Mobile Wallet Adapter registers the phone's own
// wallet (Seed Vault on a Seeker) before the list is built. It registers only where local
// association works (a secure, non-webview Android browser); elsewhere it does nothing. The
// transaction check above still runs before every signature it is asked for.
if (config.cluster === 'mainnet')
  registerMwa({
    appIdentity: { name: 'nuntius', uri: location.origin, icon: 'identity-icon-192.png' },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: ['solana:mainnet'],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  })
getWallets().on('register', showWallets)
showWallets()
void loadLaunch()
