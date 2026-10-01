/**
 * Serves the web build the way the phone starts: rendered on the client only
 * (no prerendered page) and with the fonts loading at runtime, late. API calls
 * answer 503, as if offline: these tests are about the app shell.
 *
 *   WEB_DIR=/tmp/web npm run test:e2e   # an existing `npx expo export -p web`
 *   npm run test:e2e                    # exports one first
 *
 * Needs a Chromium for playwright-core (npx playwright-core install chromium).
 */
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const TYPES = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.ttf': 'font/ttf' }

export async function startWeb() {
  let webDir = process.env.WEB_DIR
  if (!webDir) {
    webDir = mkdtempSync(path.join(tmpdir(), 'nuntius-web-'))
    execFileSync('npx', ['expo', 'export', '-p', 'web', '--output-dir', webDir], { stdio: 'inherit' })
  }
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
  return {
    base,
    browser,
    async close() {
      await browser.close()
      server.close()
    },
  }
}

/** Holds every font file back by `ms`, as a cold phone loads them after the first frame. */
export async function lateFonts(page, ms = 1000) {
  await page.route(/\.(ttf|otf)(\?|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, ms))
    await route.continue()
  })
}
