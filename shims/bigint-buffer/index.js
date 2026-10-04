'use strict'
// bigint-buffer's API without its native binding (GHSA-3gc7-fjrx-p6mg). The
// conversions are the package's own pure-JavaScript fallback; see NOTICE.

function bytes(buf, fn) {
  if (!(buf instanceof Uint8Array)) throw new TypeError(`${fn}: expected a Buffer or Uint8Array`)
  // A copy of exactly this view: nothing outside it is ever read.
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
}

function toBigIntLE(buf) {
  const reversed = Buffer.from(bytes(buf, 'toBigIntLE'))
  reversed.reverse()
  const hex = reversed.toString('hex')
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`)
}

function toBigIntBE(buf) {
  const hex = bytes(buf, 'toBigIntBE').toString('hex')
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`)
}

function width(w, fn) {
  if (!Number.isSafeInteger(w) || w < 0) throw new RangeError(`${fn}: width must be a non-negative integer`)
  return w
}

function toBufferLE(num, w) {
  const n = width(w, 'toBufferLE')
  const hex = num.toString(16)
  const buffer = Buffer.from(hex.padStart(n * 2, '0').slice(0, n * 2), 'hex')
  buffer.reverse()
  return buffer
}

function toBufferBE(num, w) {
  const n = width(w, 'toBufferBE')
  const hex = num.toString(16)
  return Buffer.from(hex.padStart(n * 2, '0').slice(0, n * 2), 'hex')
}

module.exports = { toBigIntLE, toBigIntBE, toBufferLE, toBufferBE }
