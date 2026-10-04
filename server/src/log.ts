/**
 * Logging that cannot leak. Every line passes through `redact`, which removes
 * what must never reach a log file: RPC and Anthropic API keys, session tokens, FCM
 * registration tokens, bearer tokens, and anything shaped like a serialized
 * secret key. Public chain data (addresses, signatures, amounts) is kept,
 * because a log without it cannot be checked against the chain.
 */

const RULES: [RegExp, string][] = [
  // api-key / apikey / key / token query parameters in any URL.
  [/([?&](?:api[-_]?key|apikey|key|token|access_token)=)[^&\s"']+/gi, '$1***'],
  // Authorization headers.
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***'],
  // Anthropic API keys (v1.0.2 "Type it your way"), wherever they appear.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[anthropic-key]'],
  // A 64-number JSON array is a Solana CLI keypair file's contents.
  [/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g, '[secret-key]'],
  // A JSON SyntaxError quotes a slice of its input: ..."9,238,135,x]" is not valid JSON.
  [/(Unexpected token .{1,6}?, )(?:\.\.\.)?\\?".*?\\?"(?:\.\.\.)? is not valid JSON/g, '$1[input] is not valid JSON'],
  // FCM registration tokens: instance id, colon, long blob.
  [/\b[A-Za-z0-9_-]{11,}:[A-Za-z0-9_-]{100,}\b/g, '[push-token]'],
  // Session tokens: 32 random bytes as base64url = exactly 43 chars. Solana
  // signatures are 87-88 base58 chars and addresses 32-44 base58 chars; base58
  // has no '-' or '_', so require one of those or a mixed-case run of 43 that
  // is labelled as a session.
  [/("?session"?\s*[:=]\s*"?)[A-Za-z0-9_-]{43}/gi, '$1***'],
  [/\b(?=[A-Za-z0-9_-]{43}\b)(?=[A-Za-z0-9]*[-_])[A-Za-z0-9_-]{43}\b/g, '[session]'],
]

export function redact(text: string): string {
  let out = text
  for (const [re, rep] of RULES) out = out.replace(re, rep)
  return out
}

export type LogFields = Record<string, string | number | boolean | null | undefined | bigint>

export interface Logger {
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
}

/** One JSON object per line, redacted. `sink` is injectable so tests can read what was written. */
export function createLogger(sink: (line: string) => void = (l) => console.log(l)): Logger {
  const write = (level: string, event: string, fields: LogFields = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    )
    sink(redact(line))
  }
  return {
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
  }
}

/** Error text that is safe to log or return: redacted and bounded. */
export function safeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error'
  return redact(raw).slice(0, 300)
}
