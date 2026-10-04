/**
 * The home-screen widget, rendered the way react-native-android-widget renders
 * it: its buildWidgetTree calls each component as a plain function, outside any
 * React tree. The file is compiled with the React Compiler, as the app is
 * (app.json experiments.reactCompiler), so a hook added by the compiler fails
 * here exactly as it did on the device ("Invalid Hook Call", blank widget).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { widgetView, type WidgetSnapshot } from './widget-model.ts'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const babel = require('@babel/core') as typeof import('@babel/core')

function compile(file: string, source = readFileSync(path.join(root, file), 'utf8')): string {
  return babel.transformSync(source, {
    filename: path.join(root, file),
    babelrc: false,
    configFile: false,
    plugins: [
      [require.resolve('babel-plugin-react-compiler'), { target: '19' }],
      [require.resolve('@babel/plugin-transform-typescript'), { isTSX: true, allExtensions: true }],
      [require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'automatic' }],
      require.resolve('@babel/plugin-transform-modules-commonjs'),
    ],
  })!.code!
}

/**
 * Compiled modules are written as ordinary CommonJS files and loaded with
 * require(), never evaluated from a string. They sit under node_modules/.cache
 * (git-ignored) so `react` and the JSX runtime resolve from the app's own
 * node_modules. The two imports the device supplies are pointed at local files:
 * the library's primitives (stand-ins with the shape buildWidgetTree walks) and
 * the compiled app styles.
 */
const outDir = path.join(root, 'node_modules', '.cache', 'nuntius-widget-render')
mkdirSync(outDir, { recursive: true })
writeFileSync(
  path.join(outDir, 'widget-lib.cjs'),
  `const primitive = (name) => Object.assign(() => null, { __name__: name, convertProps: (p) => p })
module.exports = { FlexWidget: primitive('FlexWidget'), TextWidget: primitive('TextWidget') }
`,
)
writeFileSync(path.join(outDir, 'app-styles.cjs'), compile('constants/app-styles.ts'))
let loads = 0

function load(file: string, source?: string) {
  let code = compile(file, source)
  for (const [id, local] of [
    ['react-native-android-widget', './widget-lib.cjs'],
    ['@/constants/app-styles', './app-styles.cjs'],
  ]) {
    const from = `require("${id}")`
    assert.ok(code.includes(from), `the widget imports ${id}`)
    code = code.replaceAll(from, `require("${local}")`)
  }
  // A new file per load, so the require cache never hands back an earlier compile.
  const out = path.join(outDir, `permissions-widget-${process.pid}-${loads++}.cjs`)
  writeFileSync(out, code)
  return require(out) as {
    PermissionsWidget: import('react').FunctionComponent<{ view: ReturnType<typeof widgetView> }>
  }
}

const { buildWidgetTree } = require(
  path.join(root, 'node_modules/react-native-android-widget/lib/commonjs/api/build-widget-tree.js'),
) as { buildWidgetTree: (el: unknown) => { type: string; props: Record<string, unknown>; children?: unknown[] } }
const React = require('react') as typeof import('react')

type Tree = { type: string; props: Record<string, unknown>; children?: Tree[] }
const texts = (t: Tree): string[] => [
  ...(t.type === 'TextWidget' ? [String(t.props.text)] : []),
  ...(t.children ?? []).flatMap((c) => texts(c)),
]

const NOW = Date.UTC(2026, 8, 30, 15, 0)
const snap: WidgetSnapshot = {
  fetchedAt: NOW,
  rows: [{ label: 'natXcheck', symbol: 'USDC', cap: '0.05', remaining: '0', nextResetTs: NOW / 1000 + 3600 }],
  liveCount: 1,
  lastReceipt: null,
  streak: 1,
  clockedInToday: true,
}

test('widget: renders without hooks for signed out, error, first load and live', () => {
  const { PermissionsWidget } = load('features/widget/permissions-widget.tsx')
  const cases: [string, ReturnType<typeof widgetView>, RegExp][] = [
    ['signed out', widgetView(null, false, NOW), /Sign in to see your permissions/],
    ['error', widgetView(null, true, NOW, true), /Could not load\. Tap to open nuntius/],
    ['never loaded', widgetView(null, true, NOW), /Open nuntius to load/],
    ['live', widgetView(snap, true, NOW), /natXcheck/],
  ]
  for (const [name, view, want] of cases) {
    const tree = buildWidgetTree(React.createElement(PermissionsWidget, { view })) as Tree
    assert.equal(tree.type, 'FlexWidget', name)
    assert.equal(
      (tree.props.style as { backgroundColor?: string }).backgroundColor,
      '#FFFFFF',
      `${name}: the white card is drawn`,
    )
    assert.match(texts(tree).join(' | '), want, name)
    assert.ok(texts(tree).includes('nuntius'), `${name}: title`)
  }
})

test('widget: without "use no memo" the compiler adds a hook and the render fails as on the device', () => {
  const source = readFileSync(path.join(root, 'features/widget/permissions-widget.tsx'), 'utf8').replace(
    /^'use no memo'\s*$/m,
    '',
  )
  assert.doesNotMatch(source, /use no memo'\s*$/m)
  const { PermissionsWidget } = load('features/widget/permissions-widget.tsx', source)
  assert.throws(
    () => buildWidgetTree(React.createElement(PermissionsWidget, { view: widgetView(snap, true, NOW) })),
    // On the device React's dispatcher check reports it and the library rewords it as
    // "Invalid Hook Call detected in PermissionsWidget"; in Node the same compiler
    // hook reaches the null dispatcher first. Either way: the hook added by the compiler.
    /Invalid Hook Call detected in PermissionsWidget|reading 'useMemoCache'/,
  )
})
