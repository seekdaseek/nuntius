/**
 * Cold start from a notification tap, in the web build of the real app.
 *
 * Device check 7 (30 Sep): with the process gone, tapping a push crashed the
 * app with "Maximum update depth exceeded … at RootLayout". The tap routing
 * called router.push() while the root layout still rendered nothing (fonts
 * loading), so there was no navigator to land in. Here the tap is present
 * before the first render (features/push/use-tap-response.web.ts), and the fonts
 * are taken out of the prerendered page and their files held back, so the app
 * starts exactly as on the phone: tap first, fonts later.
 *
 *   npx expo export -p web --output-dir /tmp/web   # or let this script do it
 *   WEB_DIR=/tmp/web npm run test:e2e
 *
 * Needs a Chromium for playwright-core (npx playwright-core install chromium).
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

let webDir = process.env.WEB_DIR
if (!webDir) {
  webDir = mkdtempSync(path.join(tmpdir(), 'nuntius-web-'))
  execFileSync('npx', ['expo', 'export', '-p', 'web', '--output-dir', webDir], { stdio: 'inherit' })
}

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.ttf': 'font/ttf' }
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    res.writeHead(503, { 'content-type': 'application/json' })
    return res.end('{"ok":false,"error":"offline"}')
  }
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  let f = path.join(webDir, p)
  if (!existsSync(f)) f = existsSync(`${f}.html`) ? `${f}.html` : path.join(webDir, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' })
  if (f.endsWith('.html')) {
    // The static export prerenders the page with its fonts inlined. The phone
    // does neither: render on the client only, and let the fonts load late.
    const html = readFileSync(f, 'utf8')
      .replace(/<style id="expo-generated-fonts"[^>]*>[\s\S]*?<\/style>/, '')
      .replace('__EXPO_ROUTER_HYDRATE__=true', '__EXPO_ROUTER_HYDRATE__=false')
    return res.end(html)
  }
  createReadStream(f).pipe(res)
})
await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})

/** Start the app as Android does after a tap on a killed app: the response is already there. */
async function coldStart(url) {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // Fonts arrive a second late, as on a cold phone: the tap is there first.
  await page.route(/\.(ttf|otf)(\?|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, 1000))
    await route.continue()
  })
  // Every navigation the router makes, in order.
  await page.addInitScript(() => {
    globalThis.__nav = []
    for (const kind of ['pushState', 'replaceState']) {
      const original = history[kind].bind(history)
      history[kind] = (state, title, u) => {
        globalThis.__nav.push(`${kind} ${u}`)
        return original(state, title, u)
      }
    }
  })
  if (url) {
    await page.addInitScript((u) => {
      globalThis.__nuntiusTap = {
        notification: { request: { identifier: 'cold-1', content: { data: { url: u } }, trigger: null } },
      }
    }, url)
  }
  await page.goto(`${base}/`)
  await page.waitForTimeout(3500)
  const at = new URL(page.url())
  // The first entry is the router settling on "/" at start.
  const nav = (await page.evaluate(() => globalThis.__nav)).filter((n) => n !== 'replaceState /')
  await page.close()
  return { path: at.pathname, errors, nav }
}

test('a tap on a killed app opens its screen, without an update loop', async () => {
  for (const url of ['/alert?kind=pull&amount=0.01&sym=USDC', '/receipts', '/digest']) {
    const r = await coldStart(url)
    assert.deepEqual(r.errors, [], `${url}: no crash (React #185 is "Maximum update depth exceeded")`)
    assert.equal(r.path, url.split('?')[0], `${url}: landed`)
    // Routed once, as a push. Before the fix the push went out while
    // the root layout rendered nothing: the root was rebuilt, the tap routed
    // again, and each time as a replace (on the phone, again and again, until
    // "Maximum update depth exceeded").
    assert.deepEqual(r.nav, [`pushState ${url}`], `${url}: one push`)
  }
})

test('a launcher start still opens home', async () => {
  const r = await coldStart(null)
  assert.deepEqual(r.errors, [])
  assert.equal(r.path, '/')
  assert.deepEqual(r.nav, [])
})

test('a url that is not ours is ignored', async () => {
  const r = await coldStart('https://example.com/phish')
  assert.deepEqual(r.errors, [])
  assert.equal(r.path, '/')
})

test.after(async () => {
  await browser.close()
  server.close()
})
