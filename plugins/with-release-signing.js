/**
 * Expo config plugin: release signing that survives `expo prebuild --clean`.
 *
 * Wires android/app/build.gradle's `signingConfigs.release` to four Gradle
 * properties, read at build time from ~/.gradle/gradle.properties (written by
 * tools/mac/01-keystore.sh). No value ever enters the repo:
 *
 *   NUNTIUS_UPLOAD_STORE_FILE, NUNTIUS_UPLOAD_KEY_ALIAS,
 *   NUNTIUS_UPLOAD_STORE_PASSWORD, NUNTIUS_UPLOAD_KEY_PASSWORD
 *
 * When they are absent the release build falls back to the debug key and says
 * so loudly: such an APK installs, but it is not the release identity and its
 * certificate will not match assetlinks.json.
 */
const { withAppBuildGradle } = require('@expo/config-plugins')

const MARKER = '// nuntius: release signing (plugins/with-release-signing.js)'

const SIGNING_BLOCK = `
        ${MARKER}
        if (project.hasProperty('NUNTIUS_UPLOAD_STORE_FILE')) {
            release {
                storeFile file(NUNTIUS_UPLOAD_STORE_FILE)
                storePassword NUNTIUS_UPLOAD_STORE_PASSWORD
                keyAlias NUNTIUS_UPLOAD_KEY_ALIAS
                keyPassword NUNTIUS_UPLOAD_KEY_PASSWORD
            }
        }`

const RELEASE_SIGNING = `if (project.hasProperty('NUNTIUS_UPLOAD_STORE_FILE')) {
                signingConfig signingConfigs.release
            } else {
                logger.warn("nuntius: NUNTIUS_UPLOAD_* not found in ~/.gradle/gradle.properties. The release APK is signed with the DEBUG key. Run tools/mac/01-keystore.sh.")
                signingConfig signingConfigs.debug
            }`

function applySigning(gradle) {
  if (gradle.includes(MARKER)) return gradle
  if (!/signingConfigs\s*\{/.test(gradle))
    throw new Error('with-release-signing: no signingConfigs block in app/build.gradle')
  let out = gradle.replace(/signingConfigs\s*\{/, (m) => `${m}${SIGNING_BLOCK}`)
  // Only the release build type's signingConfig line changes; debug keeps the debug key.
  const release = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/
  if (!release.test(out)) throw new Error('with-release-signing: release buildType signingConfig not found')
  out = out.replace(release, (_m, head) => `${head}${RELEASE_SIGNING}`)
  return out
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    if (c.modResults.language !== 'groovy') throw new Error('with-release-signing: expected a Groovy build.gradle')
    c.modResults.contents = applySigning(c.modResults.contents)
    return c
  })
}
module.exports.applySigning = applySigning
