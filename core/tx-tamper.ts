/**
 * Test support for core/tx-check.ts: change one thing in a real transaction
 * (an amount, an account, an extra instruction, the fee payer) and re-encode it,
 * so a test can show the check refuses exactly that change.
 */
import {
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
} from '@solana/kit'

type Message = {
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number }
  staticAccounts: Address[]
  instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[]
}
export interface Editable {
  keys: string[]
  ixs: { programAddressIndex: number; accountIndices: number[]; data: Uint8Array }[]
  /** Appends a read-only, non-signer account and returns its index. */
  add(address: string): number
  /** The instruction whose program is `program` and first data byte `disc`. */
  find(program: string, disc: number): { programAddressIndex: number; accountIndices: number[]; data: Uint8Array }
  setFeePayer(address: string): void
}

export function tamper(base64: string, edit: (m: Editable) => void): string {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64))
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as Message
  const keys = [...(msg.staticAccounts as string[])]
  const header = { ...msg.header }
  const ixs = (msg.instructions ?? []).map((ix) => ({
    programAddressIndex: ix.programAddressIndex,
    accountIndices: [...(ix.accountIndices ?? [])],
    data: new Uint8Array(ix.data ?? new Uint8Array()),
  }))
  const m: Editable = {
    keys,
    ixs,
    add(address) {
      keys.push(address)
      header.numReadonlyNonSignerAccounts++
      return keys.length - 1
    },
    find(program, disc) {
      const ix = ixs.find((i) => keys[i.programAddressIndex] === program && i.data[0] === disc)
      if (!ix) throw new Error(`no ${program} instruction ${disc}`)
      return ix
    },
    setFeePayer(address) {
      keys[0] = address
    },
  }
  edit(m)
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...msg,
    header,
    staticAccounts: keys as Address[],
    instructions: ixs,
  } as never)
  const signers = keys.slice(0, header.numSignerAccounts)
  const out = getTransactionEncoder().encode({
    messageBytes,
    signatures: Object.fromEntries(signers.map((s) => [s, null])),
  } as never)
  return getBase64Decoder().decode(out)
}

/** Little-endian u64 into `data` at `at`. */
export function setU64(data: Uint8Array, at: number, v: bigint) {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(at, v, true)
}
export function getU64(data: Uint8Array, at: number) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(at, true)
}
