/**
 * The MWA app identity lives on the backend's own host
 * (https://nuntius.ochinimus.app), so wallets can verify the app without any
 * deploy on ochinimus.app:
 *
 * - GET /.well-known/assetlinks.json — the Digital Asset Links statement that
 *   binds package app.ochinimus.nuntius, signed by the release key, to this
 *   origin. Wallets check that the calling package's signing certificate is
 *   listed in an android_app statement here (MWA 2.0 spec, identity
 *   verification). 404 until ANDROID_CERT_SHA256 is configured: a statement
 *   with a wrong or missing fingerprint is worse than none.
 * - GET /identity-icon-192.png — the icon the identity's relative `icon` path
 *   points at.
 */
import path from 'node:path'
import type express from 'express'

export const ANDROID_PACKAGE = 'app.ochinimus.nuntius'
export const ICON_PATH = '/identity-icon-192.png'
/** A token asset under /t/: lowercase name, png or json, no path. */
const TOKEN_FILE_RE = /^[a-z0-9][a-z0-9-]{0,40}\.(png|json)$/
const FINGERPRINT_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/

/** Validates and normalises a SHA-256 certificate fingerprint (32 colon-separated hex bytes). */
export function parseCertFingerprint(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null
  const v = raw.trim().toUpperCase()
  if (!FINGERPRINT_RE.test(v)) {
    throw new Error('ANDROID_CERT_SHA256 must be 32 colon-separated hex bytes (keytool -list -v prints it as SHA256:)')
  }
  return v
}

export function assetLinks(fingerprint: string) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: [fingerprint] },
    },
  ]
}

export function registerIdentityRoutes(app: express.Express, fingerprint: string | null, staticDir: string): void {
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    if (!fingerprint) {
      res.status(404).json({ ok: false, error: 'not_configured' })
      return
    }
    res.type('application/json').send(JSON.stringify(assetLinks(fingerprint)))
  })
  app.get(ICON_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.sendFile(path.join(staticDir, 'identity-icon-192.png'))
  })
  // Launch token assets that live in this repository (static/tokens): images, and the fixed
  // metadata JSON of tokens nuntius creates itself (the proof pool). Plain names only.
  app.get('/t/:file', (req, res) => {
    const file = String(req.params.file)
    if (!TOKEN_FILE_RE.test(file)) return void res.status(404).json({ ok: false, error: 'not_found' })
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.sendFile(path.join(staticDir, 'tokens', file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ ok: false, error: 'not_found' })
    })
  })
}
