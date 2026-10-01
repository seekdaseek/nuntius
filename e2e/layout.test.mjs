/**
 * The app shell's text at phone widths, as the phone starts it: client render,
 * fonts late. Device check 1 (1 Oct): next to "✓ Seeker verified" the wordmark
 * read "nuntiu".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lateFonts, startWeb } from './harness.mjs'

const { base, browser, close } = await startWeb()

const SEEKER = { address: 'Qf4HWsQQCtmH7FwUxGVsw5maD8W7sK2HkXdRHdpAHME', session: 'x'.repeat(43), sgtMint: 'SgtMint' }

/** Every visible text box whose content is wider than the box: text cut off. */
function clipped(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('div[dir="auto"], span')]
      .filter((el) => el.childElementCount === 0 && el.textContent.trim() && el.offsetParent !== null)
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent.trim()),
  )
}

test('the wordmark and the Seeker chip both fit, at 320 and 360 dp', async () => {
  for (const width of [320, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 760 } })
    await lateFonts(page)
    await page.addInitScript((a) => localStorage.setItem('nuntius-auth-v1', JSON.stringify(a)), SEEKER)
    await page.goto(`${base}/`)
    await page.waitForSelector('text=nuntius', { timeout: 15000 })
    await page.waitForTimeout(2000)
    const word = await page.locator('[data-testid=wordmark]').boundingBox()
    const chip = await page.getByText('Seeker verified').boundingBox()
    assert.ok(word && chip, 'both drawn')
    assert.ok(word.x + word.width <= chip.x, `${width}: the chip starts after the wordmark ends`)
    assert.deepEqual(await clipped(page), [], `${width}: no text cut off`)
    await page.close()
  }
})

test.after(close)
