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
