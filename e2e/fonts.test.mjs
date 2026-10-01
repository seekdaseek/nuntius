/**
 * No text before the fonts. Device check 11 (1 Oct): on the first launch after
 * a restart, text was cut off all over the app ("nuntiu", "Seeker verifiec",
 * "Sign oui", "New permissior"). Screens were drawn before Bricolage and
 * Figtree were in; Android measured each text with the fallback font and
 * kept that size. Here the font files are held until the test lets them go.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startWeb } from './harness.mjs'

const { base, browser, close } = await startWeb()

const SEEKER = { address: 'Qf4HWsQQCtmH7FwUxGVsw5maD8W7sK2HkXdRHdpAHME', session: 'x'.repeat(43), sgtMint: 'SgtMint' }

for (const [name, auth, words] of [
  ['signed out', null, ['nuntius', 'Grant a payment once']],
  ['signed in', SEEKER, ['nuntius', 'Seeker verified', 'New permission']],
]) {
  test(`${name}: no screen text until the fonts are in, then all of it`, async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    let release
    const fontsHeld = new Promise((r) => (release = r))
    await page.route(/\.(ttf|otf)(\?|$)/, async (route) => {
      await fontsHeld
      await route.continue()
    })
    if (auth) await page.addInitScript((a) => localStorage.setItem('nuntius-auth-v1', JSON.stringify(a)), auth)
    await page.goto(`${base}/`)
    await page.waitForTimeout(2000)
    const before = await page.evaluate(() => document.body.innerText.trim())
    assert.equal(before, '', `nothing drawn with the fallback font: ${JSON.stringify(before.slice(0, 80))}`)
    assert.equal(await page.locator('[data-testid=font-gate]').count(), 1, 'the screen waits behind its gate')
    release()
    for (const w of words) await page.waitForSelector(`text=${w}`, { timeout: 15000 })
    const family = await page
      .locator('[data-testid=wordmark]')
      .evaluate((el) => getComputedStyle(el.querySelector('div[dir="auto"], span') ?? el).fontFamily)
    assert.match(family, /Bricolage/)
    assert.deepEqual(errors, [])
    await page.close()
  })
}

test.after(close)
