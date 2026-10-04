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

test('Clock in: an unsaved digest hour is saved from the footer, in full view, above Clock in', async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
  await page.addInitScript((a) => localStorage.setItem('nuntius-auth-v1', JSON.stringify(a)), SEEKER)
  await page.goto(`${base}/digest`)
  await page.waitForSelector('[data-testid=digest-later]', { timeout: 15000 })
  await page.click('[data-testid=digest-later]')
  const save = await page.locator('[data-testid=digest-save]').boundingBox()
  const clock = await page.locator('[data-testid=clock-in]').boundingBox()
  assert.ok(save, 'Save is drawn')
  assert.equal(await page.locator('[data-testid=digest-save]').textContent(), 'Send it at 09:00')
  assert.ok(save.y >= 0 && save.y + save.height <= 800, 'Save is fully on screen without scrolling')
  if (clock) assert.ok(save.y + save.height <= clock.y, 'and not behind Clock in')
  await page.close()
})

test.after(close)

test('v1.0.1: launch and back stay hidden when the server does not turn them on', async () => {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } })
  await page.addInitScript((a) => localStorage.setItem('nuntius-auth-v1', JSON.stringify(a)), SEEKER)
  await page.goto(`${base}/new?mints=USDC,SKR`)
  await page.waitForSelector('[data-testid=starter-allowance]', { timeout: 15000 })
  assert.equal(await page.locator('[data-testid=starter-builder]').count(), 0, 'no "Back a Seeker builder"')
  for (const [path, words] of [
    ['/back', 'Backing a launch is not available in this version.'],
    ['/launch', 'Launching a token is not available in this version.'],
  ]) {
    await page.goto(`${base}${path}`)
    await page.waitForSelector(`text=${words}`, { timeout: 15000 })
  }
  assert.equal(await page.locator('[data-testid=back-approve]').count(), 0)
  assert.equal(await page.locator('[data-testid=launch]').count(), 0)
  await page.close()
})
