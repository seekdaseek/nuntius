/**
 * BACK goes where people expect. Device check 10 (1 Oct): BACK from Clock in,
 * opened by the digest push, did not leave it: a tap that opens a screen
 * already open stacked a second copy.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lateFonts, startWeb } from './harness.mjs'

const { base, browser, close } = await startWeb()

const SEEKER = { address: 'Qf4HWsQQCtmH7FwUxGVsw5maD8W7sK2HkXdRHdpAHME', session: 'x'.repeat(43), sgtMint: 'SgtMint' }
const tapOf = (url, id) => ({
  notification: { request: { identifier: id, content: { data: { url } }, trigger: null } },
})

async function open(path, coldTap) {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
  await lateFonts(page, 300)
  await page.addInitScript((a) => localStorage.setItem('nuntius-auth-v1', JSON.stringify(a)), SEEKER)
  if (coldTap) await page.addInitScript((t) => (globalThis.__nuntiusTap = t), coldTap)
  await page.goto(`${base}${path}`)
  await page.waitForTimeout(2500)
  return page
}
const at = (page) => new URL(page.url()).pathname
const back = async (page) => {
  await page.getByLabel('Back').first().click()
  await page.waitForTimeout(800)
}

test('digest push on a killed app: Clock in, and BACK goes home', async () => {
  const page = await open('/', tapOf('/digest?source=digest', 'digest'))
  assert.equal(at(page), '/digest')
  await back(page)
  assert.equal(at(page), '/')
  await page.close()
})

test('digest push while Clock in is already open: still one Clock in, BACK goes home', async () => {
  const page = await open('/')
  await page.getByText('Clock in').first().click()
  await page.waitForTimeout(800)
  assert.equal(at(page), '/digest')
  await page.evaluate(
    (t) => window.dispatchEvent(new CustomEvent('nuntius-tap', { detail: t })),
    tapOf('/digest?source=digest', 'digest'),
  )
  await page.waitForTimeout(800)
  assert.equal(at(page), '/digest')
  await back(page)
  assert.equal(at(page), '/', 'one BACK leaves Clock in')
  await page.close()
})

test('a screen with nothing under it: the back arrow goes home', async () => {
  const page = await open('/receipts')
  await back(page)
  assert.equal(at(page), '/')
  await page.close()
})

test.after(close)
