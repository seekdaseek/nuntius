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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
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

/** Stand-ins for the library's primitives: the same shape buildWidgetTree walks. */
function primitive(name: string) {
  const f = () => null
  return Object.assign(f, { __name__: name, convertProps: (p: unknown) => p })
}
const widgetLib = { FlexWidget: primitive('FlexWidget'), TextWidget: primitive('TextWidget') }

function load(file: string, source?: string) {
  const code = compile(file, source)
  const module = { exports: {} as Record<string, unknown> }
  const req = (id: string) => {
    if (id === 'react-native-android-widget') return widgetLib
    if (id === '@/constants/app-styles') return loadPlain('constants/app-styles.ts')
    return require(id)
  }
  vm.runInThisContext(`(function (require, module, exports) {${code}\n})`)(req, module, module.exports)
  return module.exports as {
    PermissionsWidget: import('react').FunctionComponent<{ view: ReturnType<typeof widgetView> }>
  }
}
function loadPlain(file: string) {
  const module = { exports: {} as Record<string, unknown> }
  vm.runInThisContext(`(function (require, module, exports) {${compile(file)}\n})`)(require, module, module.exports)
  return module.exports
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
