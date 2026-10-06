// Bundles web/src/backing.ts into server/static/l/backing.js and copies the page's two OFL
// fonts next to it. The bundle is committed, so the server needs no build step of its own.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'server', 'static', 'l')
mkdirSync(out, { recursive: true })
await build({
  entryPoints: [path.join(import.meta.dirname, 'src', 'backing.ts')],
  outfile: path.join(out, 'backing.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'info',
})
const fonts = [
  ['bricolage-grotesque', '800ExtraBold', 'BricolageGrotesque_800ExtraBold.ttf'],
  ['figtree', '400Regular', 'Figtree_400Regular.ttf'],
  ['figtree', '600SemiBold', 'Figtree_600SemiBold.ttf'],
]
for (const [pkg, dir, file] of fonts)
  copyFileSync(path.join(root, 'node_modules', '@expo-google-fonts', pkg, dir, file), path.join(out, file))
copyFileSync(
  path.join(root, 'node_modules', '@expo-google-fonts', 'figtree', 'LICENSE_FONT'),
  path.join(out, 'OFL-figtree.txt'),
)
copyFileSync(
  path.join(root, 'node_modules', '@expo-google-fonts', 'bricolage-grotesque', 'LICENSE_FONT'),
  path.join(out, 'OFL-bricolage.txt'),
)

// The Mobile Wallet Adapter's own dialogs (wallet-standard-mobile) style themselves with fixed
// <style> blocks and two style attributes. The page's CSP allows exactly those, by hash, so
// they are computed here from the package that was just bundled and written next to the bundle
// (server/src/launch-api.ts reads mwa-csp.json). A package whose dialogs changed shape fails here.
{
  const { createHash } = await import('node:crypto')
  const { readFileSync, writeFileSync } = await import('node:fs')
  const src = readFileSync(
    path.join(
      import.meta.dirname,
      'node_modules',
      '@solana-mobile',
      'wallet-standard-mobile',
      'lib',
      'esm',
      'index.browser.js',
    ),
    'utf8',
  )
  const css = {}
  for (const m of src.matchAll(/const (css(?:\$\d+)?) = (`[^`]*`);/g)) css[m[1]] = new Function(`return ${m[2]}`)()
  const base = /styles\.textContent = (css\$\d+) \+ this\.contentStyles;/.exec(src)?.[1]
  const contents = [...src.matchAll(/contentStyles = (css(?:\$\d+)?);/g)].map((m) => m[1])
  const lone = [...src.matchAll(/styles\.textContent = (css(?:\$\d+)?);/g)].map((m) => m[1])
  const attrs = [...new Set([...src.matchAll(/style="([^"]*)"/g)].map((m) => m[1]))]
  if (
    !base ||
    contents.length < 4 ||
    lone.length < 1 ||
    attrs.length < 1 ||
    contents.concat(lone, [base]).some((k) => !css[k])
  )
    throw new Error(
      'wallet-standard-mobile: its dialog styles are not where build.mjs expects them; recheck the CSP hashes',
    )
  const hash = (t) => `'sha256-${createHash('sha256').update(t, 'utf8').digest('base64')}'`
  const styles = [...new Set([...contents.map((k) => css[base] + css[k]), ...lone.map((k) => css[k])].map(hash))]
  writeFileSync(
    path.join(out, 'mwa-csp.json'),
    JSON.stringify({ package: '@solana-mobile/wallet-standard-mobile', styles, attributes: attrs.map(hash) }, null, 2) +
      '\n',
  )
}
