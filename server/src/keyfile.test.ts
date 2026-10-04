// A malformed key file must not reach a log: Node 22's JSON.parse SyntaxError quotes the
// input, so the old `error.message` line put key bytes in the PM2 log (audit, 2 Oct).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { jsonSecretFromFile, keypairFromFile, SecretFileError } from './keyfile.js'
import { FcmSender } from './fcm.js'
import { createLogger, safeError } from './log.js'

/** A keypair file broken near its end, the shape that made Node quote "...9,238,135,x]". */
function malformedKey(): { text: string; bytes: number[] } {
  const bytes = [...randomBytes(64)]
  return { text: `[${bytes.slice(0, 63).join(',')},x]`, bytes }
}

/** No run of the file's numbers (three in a row, as the parser quotes them) appears in `out`. */
function assertNoBytes(out: string, bytes: number[]) {
  for (let i = 0; i + 3 <= 63; i++) {
    const run = bytes.slice(i, i + 3).join(',')
    assert.ok(!out.includes(run), `"${run}" from the key file appears in: ${out}`)
  }
  assert.ok(!out.includes(',x]'), `the parser's quote appears in: ${out}`)
}

test('the parser really quotes the key file (the leak this guards against)', () => {
  const { text } = malformedKey()
  let message = ''
  try {
    JSON.parse(text)
  } catch (e) {
    message = (e as Error).message
  }
  assert.match(message, /,x\]/, `Node ${process.version} quotes the input: ${message}`)
})

test('a malformed executor key: the thrown error names the file, never its content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nuntius-key-'))
  const { text, bytes } = malformedKey()
  await writeFile(join(dir, 'delegatee.json'), text)
  const e = await keypairFromFile(join(dir, 'delegatee.json'), 'MANDATE_DELEGATEE').catch((x: unknown) => x)
  assert.ok(e instanceof SecretFileError)
  assert.equal(e.message, 'MANDATE_DELEGATEE: the file is not a valid key file')
  assertNoBytes(`${e.message}\n${e.stack ?? ''}\n${String(e.cause ?? '')}`, bytes)
  // Valid JSON, wrong shape (63 numbers): refused the same way.
  await writeFile(join(dir, 'short.json'), JSON.stringify(bytes.slice(0, 63)))
  await assert.rejects(keypairFromFile(join(dir, 'short.json'), 'k'), /not a valid key file/)
  await assert.rejects(keypairFromFile(join(dir, 'absent.json'), 'k'), /could not be read/)
})

test('a malformed FCM service account file: the error holds none of the private key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nuntius-key-'))
  const secret = randomBytes(24).toString('base64')
  await writeFile(join(dir, 'fcm.json'), `{"client_email":"a@b","private_key":"${secret}",}`)
  let message = ''
  try {
    new FcmSender(join(dir, 'fcm.json'), 'p')
  } catch (e) {
    message = `${(e as Error).message}\n${(e as Error).stack ?? ''}`
  }
  assert.match(message, /FCM_SERVICE_ACCOUNT: the file is not a valid key file/)
  assert.ok(!message.includes(secret.slice(0, 12)), message)
  assert.throws(() => jsonSecretFromFile(join(dir, 'absent.json'), 'X'), /could not be read/)
})

test('defence in depth: the logger redacts a quoted slice of key bytes', () => {
  const { text, bytes } = malformedKey()
  let err: unknown
  try {
    JSON.parse(text)
  } catch (e) {
    err = e
  }
  const lines: string[] = []
  createLogger((l) => lines.push(l)).warn('x', { error: (err as Error).message })
  assertNoBytes(lines[0]!, bytes)
  assertNoBytes(safeError(err), bytes)
  assert.match(safeError(err), /\[input\] is not valid JSON/)
  // Ordinary log content is kept.
  assert.match(safeError(new Error('InstructionError [3,{"Custom":6003}] at slot 412,000,123')), /6003/)
})
