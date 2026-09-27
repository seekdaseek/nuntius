// Renders deck/deck.html to deck/nuntius-deck.pdf (1600x900 pages) with Playwright's Chromium.
//   node deck/build-deck.cjs
// On the Mac: `npm i -g playwright && npx playwright install chromium` once.
const path = require('path')
let playwright
try {
  playwright = require('playwright')
} catch {
  playwright = require('/opt/node22/lib/node_modules/playwright')
}
;(async () => {
  const browser = await playwright.chromium.launch()
  const page = await browser.newPage()
  await page.goto('file://' + path.join(__dirname, 'deck.html'), { waitUntil: 'load' })
  await page.pdf({
    path: path.join(__dirname, 'nuntius-deck.pdf'),
    width: '1600px',
    height: '900px',
    printBackground: true,
  })
  // One PNG per slide for review.
  await page.setViewportSize({ width: 1600, height: 900 })
  const n = await page.locator('section.slide').count()
  for (let i = 0; i < n; i++) {
    await page
      .locator('section.slide')
      .nth(i)
      .screenshot({ path: path.join(__dirname, 'preview', `slide-${String(i + 1).padStart(2, '0')}.png`) })
  }
  await browser.close()
  console.log(`deck: ${n} slides -> deck/nuntius-deck.pdf`)
})()
