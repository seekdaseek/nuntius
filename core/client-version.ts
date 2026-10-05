/**
 * This build's version, sent on every API call as `x-nuntius-client`. The server shows
 * subscription launches only to 1.1.0 or later (server/src/client-version.ts), so a
 * build's version decides what it can reach. It must equal app.json's `expo.version`:
 * core/client-version.test.ts fails otherwise.
 */
export const CLIENT_VERSION = '1.0.2'
export const CLIENT_HEADER = 'x-nuntius-client'

/** The header every API call carries. */
export const clientHeaders: Readonly<Record<string, string>> = { [CLIENT_HEADER]: CLIENT_VERSION }
