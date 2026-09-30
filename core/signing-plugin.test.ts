// The release-signing config plugin (plugins/with-release-signing.js), tested on
// the build.gradle shape expo prebuild generates for Expo SDK 55.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { applySigning } = require('../plugins/with-release-signing.js') as { applySigning: (g: string) => string }

const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}`

test('release signing: reads NUNTIUS_UPLOAD_* properties, falls back to debug with a warning', () => {
  const out = applySigning(TEMPLATE)
  assert.match(out, /if \(project\.hasProperty\('NUNTIUS_UPLOAD_STORE_FILE'\)\) \{\s+release \{/)
  for (const p of ['STORE_FILE', 'KEY_ALIAS', 'STORE_PASSWORD', 'KEY_PASSWORD'])
    assert.match(out, new RegExp(`NUNTIUS_UPLOAD_${p}`))
  assert.match(out, /signingConfig signingConfigs\.release/)
  assert.match(out, /logger\.warn\("nuntius: NUNTIUS_UPLOAD_\* not found/)
  // The debug build type still signs with the debug key.
  assert.match(out, /debug \{\s+signingConfig signingConfigs\.debug\s+\}/)
  assert.equal(applySigning(out), out, 'idempotent: a second prebuild pass changes nothing')
  assert.throws(() => applySigning('android { }'), /no signingConfigs/)
})
