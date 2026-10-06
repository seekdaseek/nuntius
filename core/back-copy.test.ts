import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backSentence, buyLine, checkBack, checkLaunch, demandWords, routeWords, skipWords } from './back-copy.ts'

const POOL = '4kC74bssQ1tg2MhdVSfHDyerY8sivUuZviPmmU4Sp6yq'

test('the Back sentence and its checks', () => {
  assert.equal(
    backSentence({ pool: POOL, amount: '5', period: 'week', untilDays: 90 }, 'NATX', 'USDC'),
    'Back NATX: 5 USDC every week, for 90 days.',
  )
  assert.equal(
    backSentence({ pool: POOL, amount: '', period: 'day', untilDays: 30 }, null, 'SKR'),
    'Back this launch: … SKR every day, for 30 days.',
  )
  assert.deepEqual(checkBack({ pool: '', amount: '5', period: 'week', untilDays: 90 }), {
    ok: false,
    hint: 'Paste the launch’s pool address',
  })
  assert.equal(
    checkBack({ pool: 'nope', amount: '5', period: 'week', untilDays: 90 }).hint,
    'That is not a Solana address',
  )
  assert.equal(checkBack({ pool: POOL, amount: '0', period: 'week', untilDays: 90 }).ok, false)
  assert.equal(checkBack({ pool: POOL, amount: '0.5', period: 'week', untilDays: 90 }).ok, true)
})

test('buy and skip receipts', () => {
  assert.equal(buyLine({ kind: 'buy', amount: '5', symbol: 'USDC', got: '1234 NATX' }), 'Bought 1234 NATX for 5 USDC')
  assert.equal(buyLine({ kind: 'buy', amount: '5', symbol: 'USDC', got: null }), 'Bought for 5 USDC')
  assert.equal(
    buyLine({ kind: 'skipped', amount: '5', symbol: 'USDC' }),
    'Skipped: the price moved more than 2%. Nothing was taken.',
  )
  assert.equal(buyLine({ kind: 'pull', amount: '5', symbol: 'USDC' }), null)
})

test('launch words: route, progress and committed demand', () => {
  assert.equal(routeWords({ route: 'dbc', progressPct: 23.7 }), 'Curve 23% filled')
  assert.equal(routeWords({ route: 'migrating', progressPct: 100 }), 'Curve filled: moving to its regular pool')
  assert.equal(routeWords({ route: 'damm_v2', progressPct: 100 }), 'Trading in its regular pool (DAMM v2)')
  assert.equal(demandWords({ backers: 0, perWeek: '0', symbol: null }), 'No backers yet')
  assert.equal(demandWords({ backers: 1, perWeek: '5', symbol: 'USDC' }), '1 backer commits 5 USDC a week')
  assert.equal(demandWords({ backers: 3, perWeek: '15', symbol: 'USDC' }), '3 backers commit 15 USDC a week')
  assert.equal(checkLaunch({ name: 'natXbuilder', symbol: 'natx' }).ok, true)
  assert.equal(checkLaunch({ name: '', symbol: 'NATX' }).ok, false)
  assert.equal(checkLaunch({ name: 'x', symbol: 'N' }).ok, false)
})

test('a launch is backed in its own quote token: USDC or SKR only', async () => {
  const { quoteSymbolOf } = await import('./back-copy.ts')
  assert.equal(quoteSymbolOf('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 'USDC')
  assert.equal(quoteSymbolOf('SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'), 'SKR')
  assert.equal(quoteSymbolOf('So11111111111111111111111111111111111111112'), null)
})

test('launch and back: hidden unless the server sends features.launches = true', async () => {
  const { launchesOn } = await import('./back-copy.ts')
  assert.equal(launchesOn(undefined), false, 'list not loaded yet')
  assert.equal(launchesOn({}), false, 'an older server without the field')
  assert.equal(launchesOn({ features: {} }), false)
  assert.equal(launchesOn({ features: { launches: false } }), false)
  assert.equal(launchesOn({ features: { launches: true } }), true)
})

test('skip words name the cause; a receipt without one was a slippage miss', () => {
  assert.equal(skipWords(undefined), 'The price moved more than 2%. Nothing was taken.')
  assert.equal(skipWords('slippage'), 'The price moved more than 2%. Nothing was taken.')
  assert.match(skipWords('curve_full'), /^The curve filled before this buy\. Nothing was taken/)
  assert.equal(skipWords('no_room'), 'The curve had less room left than quoted. Nothing was taken.')
  assert.equal(skipWords('error:6043'), 'The swap failed with error 6043. Nothing was taken.')
  assert.equal(
    buyLine({ kind: 'skipped', amount: '1', symbol: 'USDC', note: 'curve_full' }),
    'Skipped: the curve filled before this buy. Nothing was taken; it buys in the regular pool once the token moves there.',
  )
  assert.equal(
    buyLine({ kind: 'skipped', amount: '1', symbol: 'USDC' }),
    'Skipped: the price moved more than 2%. Nothing was taken.',
  )
})

test('the launch screen discloses the same fee line the server sends', async () => {
  const { readFileSync } = await import('node:fs')
  const path = await import('node:path')
  const server = readFileSync(path.join(import.meta.dirname, '..', 'server', 'src', 'launch-api.ts'), 'utf8')
  const { FEES_LINE } = await import('./back-copy.ts')
  assert.ok(server.includes(`'${FEES_LINE}'`), 'server/src/launch-api.ts FEES_LINE is the same sentence')
  assert.match(FEES_LINE, /0\.4% of curve trades and half of the locked pool’s fees/)
})
